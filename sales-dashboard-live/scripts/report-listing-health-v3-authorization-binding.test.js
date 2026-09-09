// All-region scheduler repair (Work 2, Codex req 1): EXACT-REUSE + FROZEN-BUDGET AUTHORIZATION BINDING proof through
// the FULL Listing Health v3 ingestion COMPOSITION (buildListingHealthV3IngestionRelease + runListingHealthV3Ingestion),
// with REAL registry premium pricing (listings=PREMIUM/5, listings-raw=STANDARD/2). The estimator-only H2 test proves
// only the first gate (decideListingHealthV3Authorization on the freshness-aware estimate); it does NOT prove that a
// 21-token FROZEN plan is refused under 16 authorized -- because exact reuse drives the freshness-aware estimate to 0
// and would let the FIRST gate pass. This suite proves the SECOND, authoritative gate: the frozen tranche budget
// (freezeBudget -> computeFrozenTrancheBudget) counts EVERY unique planned request hash and NEVER shrinks with reuse,
// and computeListingHealthV3AuthorizationBinding binds THAT frozen ceiling to the standing authorization. So:
//   * US-CA 11 accounts (3 <=5-seller batches) => frozen 6 creates / 21 tokens > authorized 16 => awaiting-budget,
//     ZERO creates, runSources NEVER invoked -- both FRESH (refused at gate 1 on the 21-token estimate) AND under
//     FULL EXACT REUSE (gate 1 passes at 0 tokens, but the BINDING gate refuses on the unchanged 21-token frozen
//     ceiling). Reuse can NEVER smuggle an over-ceiling plan past the reservation binding.
//   * India 8 accounts (2 batches) => frozen 4 creates / 14 tokens <= authorized 16 => PROCEEDS past the binding gate
//     to paid work -- both fresh and under full reuse (the frozen ceiling is the same 14 either way; reuse only lowers
//     the OBSERVED creates truthfully, never the bound reservation ceiling).
// Authorization limits are UNCHANGED (us-ca/india maxTokens=16); awaiting-budget is reported HONESTLY. Offline, pure
// (ZERO DataDoe/network; runSources/materialize/runReports/finalizeCycle are spies). 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { buildListingHealthV3IngestionRelease } from "../lib/server/sync/listing-health-v3-ingestion-composition.js";
import { runListingHealthV3Ingestion } from "../lib/server/sync/listing-health-v3-operation.js";
import {
  readListingHealthV3Authorization,
  computeListingHealthV3AuthorizationBinding,
  LISTING_HEALTH_V3_PRICING_REVISION,
} from "../lib/server/sync/listing-health-v3-authorization.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "report-listing-health-v3-authorization-binding\n");

const API_KEY = "fixture-key";
const connections = [{ id: "primary", apiKey: API_KEY, accountPrefix: "" }];
const cycleDate = "2026-09-05";
const mkAccounts = (n, cc) => Array.from({ length: n }, (_, i) => ({ accountId: `${cc.toLowerCase()}-${String(i).padStart(2, "0")}`, country: cc, currency: cc === "IN" ? "INR" : "USD", name: `${cc}${i}` }));
const US11 = mkAccounts(11, "US"); // us-ca: 11 accounts => 3 <=5-seller batches
const IN8 = mkAccounts(8, "IN");   // india: 8 accounts  => 2 <=5-seller batches

// A minimal composition whose REAL freezeBudget uses the REAL registry premium pricing (default budgetPlanner). The
// store supports ONLY the readFrozenBudget readers (a fresh cycle => getCycleByBucketDate returns null => no persisted
// budget). getExportCache decides adoptability: null => nothing cached (fresh plan); a same-cycle fresh entry => full
// EXACT REUSE. runSources/materialize/runReports/finalizeCycle are supplied at the OPERATION call as spies.
function makeRelease({ accounts, reuse = false }) {
  const runtime = {
    // reserveExportCreate present => release.reservationSupported is truthfully true (production supports it), so the
    // operation reaches the authorization gate instead of failing closed on missing reservation support. A fresh
    // cycle has no persisted budget (getCycleByBucketDate null => readFrozenBudget null => replay:false).
    store: { reserveExportCreate: async () => "reserved", getCycleByBucketDate: async () => null, getBudget: async () => null, getBudgetHashes: async () => [] },
    dataDoe: {}, saveSnapshot: async () => ({ paramsHash: "ph" }), loadDerivedContext: async () => ({}),
  };
  const freshEntry = { fetched_at: cycleDate + "T12:00:00Z" }; // >= freshnessNotBefore (cycleDate) => adoptable
  return buildListingHealthV3IngestionRelease({
    operator: "laxmikant@superboring.in",
    makeRuntime: () => runtime,
    getConnections: () => connections,
    discoverAccountIds: async () => accounts.map((a) => a.accountId),
    readDirectoryAccounts: async () => accounts,
    // FULL EXACT REUSE returns a fresh cache entry for EVERY hash (listings/listings-raw/inventory adoptable);
    // fresh returns null (nothing cached -> every new export is a create).
    getExportCache: async () => (reuse ? { ...freshEntry } : null),
    getTokenBalance: async () => ({ read: "ok", usable: 100000 }),
    // NOTE: budgetPlanner is DELIBERATELY not overridden -> the REAL registryBudgetPlanner() (listings PREMIUM=5,
    // listings-raw STANDARD=2). This is what makes the frozen budget 21 tokens for 11 accounts (3*5 + 3*2), not a
    // simplified all-standard number.
    // Overflow evidence readers: fail-soft empty (no inventory split) so the new-export plan is byte-stable.
    getRecentCycleIds: async () => [],
    getSourceJobsWithMeta: async () => [],
    getSourceJobOwners: async () => [],
  });
}

// A spy set for the paid-work collaborators. runSources MUST NOT be called for an awaiting-budget region.
function spies() {
  const calls = { runSources: 0, materialize: 0, runReports: 0, finalizeCycle: 0, bindings: [] };
  return {
    calls,
    runSources: async ({ authorizationBinding }) => { calls.runSources += 1; calls.bindings.push(authorizationBinding); return { cycleId: "cyc-1", drained: true, creates: 0, maxCreates: 0, tokens: 0, inventoryCreated: false }; },
    materialize: async () => { calls.materialize += 1; return { accounts: 0, aliasesWritten: 0, rejected: 0 }; },
    runReports: async () => { calls.runReports += 1; return { succeeded: 1, blocked: 0, failed: 0, drained: true }; },
    finalizeCycle: async () => { calls.finalizeCycle += 1; return { disposition: "finalized", status: "succeeded", cycleId: "cyc-1" }; },
  };
}

const liveArgs = (release, sp, region, accounts) => ({
  region, cycleDate, mode: "live",
  authorized: true, gate: { enabled: true }, connections,
  discoverAccounts: release.discoverAccounts, buildPlan: release.buildPlan, resolveCost: release.resolveCost,
  checkBalance: release.checkBalance,
  freezeBudget: release.freezeBudget, readFrozenBudget: release.readFrozenBudget,
  runSources: sp.runSources, materialize: sp.materialize, runReports: sp.runReports, finalizeCycle: sp.finalizeCycle,
  reservationSupported: release.reservationSupported, pricingKnown: release.pricingKnown,
});

/* ===== 0. DIRECT freezeBudget + binding numbers (the real premium pricing, no operation orchestration) ===== */
await (async () => {
  const relUS = makeRelease({ accounts: US11 });
  const planUS = await relUS.buildPlan({ accounts: US11, connections, cycleDate, region: "us-ca" });
  const frozenUS = relUS.freezeBudget({ plan: planUS, region: "us-ca" });
  ok("0: US-CA 11 accounts freeze to 6 creates / 21 tokens (3 premium listings @5 + 3 standard listings-raw @2), NOT a flat 6*2=12",
    frozenUS.maxCreates === 6 && frozenUS.maxTokens === 21);
  const authzUS = readListingHealthV3Authorization({ region: "us-ca" });
  ok("0: the us-ca authorized ceiling is UNCHANGED (16 tokens / 8 creates) -- limits preserved", authzUS.maxTokens === 16 && authzUS.maxCreates === 8);
  const boundUS = computeListingHealthV3AuthorizationBinding({
    region: "us-ca", cycleDate, operationId: "op", trancheKey: "lhv3-new#us-ca",
    accountIds: US11.map((a) => a.accountId), frozen: frozenUS, pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION, authorization: authzUS,
  });
  ok("0: the BINDING refuses the 21-token frozen plan under 16 authorized (tokens-exceed-authorization) -- the frozen reservation ceiling, not the reuse-reduced estimate, is what is bound",
    boundUS.ok === false && boundUS.reason === "tokens-exceed-authorization");

  const relIN = makeRelease({ accounts: IN8 });
  const planIN = await relIN.buildPlan({ accounts: IN8, connections, cycleDate, region: "india" });
  const frozenIN = relIN.freezeBudget({ plan: planIN, region: "india" });
  ok("0: India 8 accounts freeze to 4 creates / 14 tokens (2 premium @5 + 2 standard @2)", frozenIN.maxCreates === 4 && frozenIN.maxTokens === 14);
  const boundIN = computeListingHealthV3AuthorizationBinding({
    region: "india", cycleDate, operationId: "op", trancheKey: "lhv3-new#india",
    accountIds: IN8.map((a) => a.accountId), frozen: frozenIN, pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION, authorization: readListingHealthV3Authorization({ region: "india" }),
  });
  ok("0: the BINDING ACCEPTS the 14-token frozen plan under 16 authorized (fits -- proceeds to paid work)", boundIN.ok === true && boundIN.binding.maxTokens === 14);
})();

/* ===== 1. FULL COMPOSITION, US-CA FRESH: refused at gate 1 on the 21-token estimate; runSources NEVER called ===== */
await (async () => {
  const release = makeRelease({ accounts: US11, reuse: false });
  const sp = spies();
  const ev = await runListingHealthV3Ingestion(liveArgs(release, sp, "us-ca", US11));
  ok("1: US-CA fresh (11 accounts) => awaiting-budget, ok:false, deferred (21-token estimate > 16 authorized)", ev.phase === "awaiting-budget" && ev.ok === false && ev.deferred === true);
  ok("1: the refusal reason is tokens-exceed-authorization (the honest awaiting-budget)", ev.authorizationReason === "tokens-exceed-authorization");
  ok("1: ZERO creates / ZERO tokens and NO snapshots (deferred before any cycle/reservation/POST)", ev.creates === 0 && ev.tokens === 0 && ev.snapshots === 0);
  ok("1: runSources / materialize / runReports / finalizeCycle were NEVER invoked (no paid work reached)", sp.calls.runSources === 0 && sp.calls.materialize === 0 && sp.calls.runReports === 0 && sp.calls.finalizeCycle === 0);
})();

/* ===== 2. FULL COMPOSITION, US-CA FULL EXACT REUSE: gate 1 passes at 0 tokens, but the BINDING gate refuses on the
          unchanged 21-token frozen ceiling; runSources STILL never called (the key proof beyond the H2 estimator). ===== */
await (async () => {
  const release = makeRelease({ accounts: US11, reuse: true });
  // Sanity: under full reuse the freshness-aware estimate really is 0 (so gate 1 alone would let it through).
  const plan = await release.buildPlan({ accounts: US11, connections, cycleDate, region: "us-ca" });
  const cost = await release.resolveCost({ plan });
  ok("2: under FULL exact reuse the freshness-aware estimate collapses to 0 creates / 0 tokens (gate 1 would pass)", cost.creates === 0 && cost.estimatedTokens === 0);
  const sp = spies();
  const ev = await runListingHealthV3Ingestion(liveArgs(release, sp, "us-ca", US11));
  ok("2: US-CA full-reuse STILL => awaiting-budget (the BINDING gate refuses the 21-token frozen reservation ceiling)", ev.phase === "awaiting-budget" && ev.ok === false);
  ok("2: the refusal is tokens-exceed-authorization from the FROZEN budget binding (not the reuse-reduced estimate)", ev.authorizationReason === "tokens-exceed-authorization");
  ok("2: reuse can NEVER smuggle an over-ceiling plan past the reservation binding -- runSources NEVER invoked, ZERO creates", sp.calls.runSources === 0 && ev.creates === 0 && ev.tokens === 0);
})();

/* ===== 3. FULL COMPOSITION, INDIA: proceeds past the binding gate to paid work -- both fresh and full-reuse ===== */
await (async () => {
  for (const reuse of [false, true]) {
    const release = makeRelease({ accounts: IN8, reuse });
    const sp = spies();
    const ev = await runListingHealthV3Ingestion(liveArgs(release, sp, "india", IN8));
    ok(`3: India (8 accounts, reuse=${reuse}) proceeds past authorization + binding to paid work (frozen 14 <= 16 authorized) -- ok:true, phase complete`, ev.ok === true && ev.phase === "complete");
    ok(`3: India (reuse=${reuse}) actually reached runSources WITH the exact authorization binding (frozen reservation bound before any POST)`,
      sp.calls.runSources === 1 && sp.calls.bindings[0] && typeof sp.calls.bindings[0].bindingHash === "string" && sp.calls.bindings[0].maxTokens === 14);
    ok(`3: India (reuse=${reuse}) bound the frozen NEW tranche (lhv3-new#india), 4 creates / 14 tokens -- unchanged by reuse (reuse lowers observed creates truthfully, never the bound ceiling)`,
      sp.calls.bindings[0].trancheKey === "lhv3-new#india" && sp.calls.bindings[0].maxCreates === 4 && sp.calls.bindings[0].maxTokens === 14);
  }
})();

writeSync(1, `\nreport-listing-health-v3-authorization-binding: ${passed} assertions passed\n`);
