// All-region FBA/LH repair (defect 1): EXACT-REUSE + FROZEN-BUDGET AUTHORIZATION BINDING proof through the FULL Listing
// Health v3 ingestion COMPOSITION (buildListingHealthV3IngestionRelease + runListingHealthV3Ingestion), with REAL
// registry premium pricing (listings=PREMIUM/5, listings-raw=STANDARD/2 => 7 tokens per <=5-seller batch).
//
// The user-approved standing token ceilings (2026-09-10) are india 28 / europe-au 49 / us-ca 28 -- priced at the REAL
// premium composition (ceil(maxAccounts/5)*7), replacing the old flat-std2 16/28/16 that FALSELY deferred healthy runs.
// So:
//   * US-CA 11 accounts (3 <=5-seller batches) => frozen 6 creates / 21 tokens <= authorized 28 => PROCEEDS to paid
//     work (this is the DEFECT FIX: the same 21-token plan that failed US natural run 34394580474 under the old 16
//     ceiling now runs), both FRESH and under FULL EXACT REUSE.
//   * India 8 accounts (2 batches) => frozen 4 creates / 14 tokens <= 28 => PROCEEDS, fresh and under full reuse.
// The critical reuse-can't-smuggle invariant is RETAINED as an explicit LOWER-POLICY fixture: under a lower authorized
// ceiling (14), the freshness-aware estimate collapses to 0 under full reuse and would pass gate 1, but the BINDING
// gate still refuses the unchanged 21-token FROZEN reservation ceiling (tokens-exceed-authorization) -- runSources
// NEVER invoked. Reuse can NEVER shrink a frozen reservation or smuggle an over-ceiling plan past the binding.
// Offline, pure (ZERO DataDoe/network; runSources/materialize/runReports/finalizeCycle are spies). 7-bit ASCII, LF.

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
    getExportCache: async () => (reuse ? { ...freshEntry } : null),
    getTokenBalance: async () => ({ read: "ok", usable: 100000 }),
    // budgetPlanner DELIBERATELY not overridden -> the REAL registryBudgetPlanner() (listings PREMIUM=5, listings-raw
    // STANDARD=2) makes the frozen budget 21 tokens for 11 accounts (3*5 + 3*2), not a flat all-standard number.
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

const liveArgs = (release, sp, region, accounts, over = {}) => ({
  region, cycleDate, mode: "live",
  authorized: true, gate: { enabled: true }, connections,
  discoverAccounts: release.discoverAccounts, buildPlan: release.buildPlan, resolveCost: release.resolveCost,
  checkBalance: release.checkBalance,
  freezeBudget: release.freezeBudget, readFrozenBudget: release.readFrozenBudget,
  runSources: sp.runSources, materialize: sp.materialize, runReports: sp.runReports, finalizeCycle: sp.finalizeCycle,
  reservationSupported: release.reservationSupported, pricingKnown: release.pricingKnown,
  ...over,
});

/* ===== 0. DIRECT freezeBudget + binding numbers under the REAL premium pricing + APPROVED 28/49/28 ceilings ===== */
await (async () => {
  const relUS = makeRelease({ accounts: US11 });
  const planUS = await relUS.buildPlan({ accounts: US11, connections, cycleDate, region: "us-ca" });
  const frozenUS = relUS.freezeBudget({ plan: planUS, region: "us-ca" });
  ok("0: US-CA 11 accounts freeze to 6 creates / 21 tokens (3 premium listings @5 + 3 standard listings-raw @2), NOT a flat 6*2=12",
    frozenUS.maxCreates === 6 && frozenUS.maxTokens === 21);
  const authzUS = readListingHealthV3Authorization({ region: "us-ca" });
  ok("0: the us-ca authorized ceiling is the APPROVED real-priced 28 tokens / 8 creates (raised from the flat-std2 16)", authzUS.maxTokens === 28 && authzUS.maxCreates === 8);
  const boundUS = computeListingHealthV3AuthorizationBinding({
    region: "us-ca", cycleDate, operationId: "op", trancheKey: "lhv3-new#us-ca",
    accountIds: US11.map((a) => a.accountId), frozen: frozenUS, pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION, authorization: authzUS,
  });
  ok("0: the BINDING now ACCEPTS the 21-token frozen plan under 28 authorized (the DEFECT FIX) -- binds the frozen reservation ceiling",
    boundUS.ok === true && boundUS.binding.maxTokens === 21 && boundUS.binding.maxCreates === 6);

  const relIN = makeRelease({ accounts: IN8 });
  const planIN = await relIN.buildPlan({ accounts: IN8, connections, cycleDate, region: "india" });
  const frozenIN = relIN.freezeBudget({ plan: planIN, region: "india" });
  ok("0: India 8 accounts freeze to 4 creates / 14 tokens (2 premium @5 + 2 standard @2)", frozenIN.maxCreates === 4 && frozenIN.maxTokens === 14);
  const boundIN = computeListingHealthV3AuthorizationBinding({
    region: "india", cycleDate, operationId: "op", trancheKey: "lhv3-new#india",
    accountIds: IN8.map((a) => a.accountId), frozen: frozenIN, pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION, authorization: readListingHealthV3Authorization({ region: "india" }),
  });
  ok("0: the BINDING ACCEPTS the 14-token frozen india plan under 28 authorized (proceeds to paid work)", boundIN.ok === true && boundIN.binding.maxTokens === 14);
})();

/* ===== 0b. LOWER-POLICY FIXTURE: the binding STILL refuses an over-ceiling frozen plan (refusal coverage retained) ===== */
await (async () => {
  // The OLD flat-std2 16-token us-ca ceiling, retained as an EXPLICIT lower-policy fixture (per the repair brief). It
  // deliberately has creates(8) and tokens(16) DECOUPLED (the old defect shape), so the binding can be exercised for a
  // TOKENS-exceed refusal specifically: frozen 6 creates <= 8 (fits) but 21 tokens > 16 (exceeds). This preserves the
  // exact refusal coverage the old policy exercised -- the binding refuses an over-ceiling frozen plan.
  const oldLowerAuthz = { authorized: true, region: "us-ca", maxAccounts: 20, maxCreates: 8, maxTokens: 16, pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION };
  const relUS = makeRelease({ accounts: US11 });
  const planUS = await relUS.buildPlan({ accounts: US11, connections, cycleDate, region: "us-ca" });
  const frozenUS = relUS.freezeBudget({ plan: planUS, region: "us-ca" });
  const bound = computeListingHealthV3AuthorizationBinding({
    region: "us-ca", cycleDate, operationId: "op", trancheKey: "lhv3-new#us-ca",
    accountIds: US11.map((a) => a.accountId), frozen: frozenUS, pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION, authorization: oldLowerAuthz,
  });
  ok("0b: under the OLD flat-std2 16-token lower-policy ceiling the BINDING refuses the 21-token frozen plan (tokens-exceed-authorization) -- refusal coverage retained",
    bound.ok === false && bound.reason === "tokens-exceed-authorization");
})();

/* ===== 1. FULL COMPOSITION, US-CA FRESH: now PROCEEDS (21 tokens <= 28 authorized); runSources RECEIVES the binding ===== */
await (async () => {
  const release = makeRelease({ accounts: US11, reuse: false });
  const sp = spies();
  const ev = await runListingHealthV3Ingestion(liveArgs(release, sp, "us-ca", US11));
  ok("1: US-CA fresh (11 accounts, 21 real tokens) now PROCEEDS under the approved 28 ceiling (ok:true, phase complete) -- the defect fix", ev.ok === true && ev.phase === "complete" && ev.awaitingBudget !== true);
  ok("1: runSources reached WITH the exact 21-token frozen binding (6 creates) bound before any POST",
    sp.calls.runSources === 1 && sp.calls.bindings[0] && typeof sp.calls.bindings[0].bindingHash === "string" && sp.calls.bindings[0].maxTokens === 21 && sp.calls.bindings[0].maxCreates === 6);
  ok("1: the bound tranche is the frozen NEW tranche (lhv3-new#us-ca)", sp.calls.bindings[0].trancheKey === "lhv3-new#us-ca");
})();

/* ===== 2. FULL COMPOSITION, US-CA FULL EXACT REUSE: proceeds; + the reuse-smuggle invariant under a LOWER policy ===== */
await (async () => {
  const release = makeRelease({ accounts: US11, reuse: true });
  // Sanity: under full reuse the freshness-aware estimate really is 0 (so gate 1 alone would pass at 0 tokens).
  const plan = await release.buildPlan({ accounts: US11, connections, cycleDate, region: "us-ca" });
  const cost = await release.resolveCost({ plan });
  ok("2: under FULL exact reuse the freshness-aware estimate collapses to 0 creates / 0 tokens (gate 1 passes at 0)", cost.creates === 0 && cost.estimatedTokens === 0);

  // 2a: under the APPROVED 28 ceiling, us-ca full reuse PROCEEDS (21 frozen <= 28).
  const spOk = spies();
  const evOk = await runListingHealthV3Ingestion(liveArgs(release, spOk, "us-ca", US11));
  ok("2a: US-CA full-reuse PROCEEDS under the approved 28 ceiling (ok:true) and binds the unchanged 21-token frozen ceiling",
    evOk.ok === true && spOk.calls.runSources === 1 && spOk.calls.bindings[0].maxTokens === 21);

  // 2b: under the OLD flat-std2 16-token lower policy (creates 8 / tokens 16, injected via readAuthorization), gate 1
  // passes at 0 tokens under full reuse (requiredCreates 6 <= 8, requiredTokens 0 <= 16), but the BINDING gate refuses
  // the unchanged 21-token FROZEN reservation ceiling -> runSources NEVER called. Reuse can't smuggle an over-ceiling plan.
  const spLow = spies();
  const lowerRead = async () => ({ authorized: true, region: "us-ca", maxAccounts: 20, maxCreates: 8, maxTokens: 16, pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION });
  const evLow = await runListingHealthV3Ingestion(liveArgs(release, spLow, "us-ca", US11, { readAuthorization: lowerRead }));
  ok("2b: under the OLD 16-token lower policy + full reuse, the BINDING gate STILL refuses the 21-token frozen ceiling (awaiting-budget, tokens-exceed-authorization)",
    evLow.phase === "awaiting-budget" && evLow.ok === false && evLow.authorizationReason === "tokens-exceed-authorization");
  ok("2b: reuse can NEVER smuggle an over-ceiling frozen plan past the binding -- runSources NEVER invoked, ZERO creates/tokens", spLow.calls.runSources === 0 && evLow.creates === 0 && evLow.tokens === 0);
})();

/* ===== 3. FULL COMPOSITION, INDIA: proceeds past the binding gate to paid work -- both fresh and full-reuse ===== */
await (async () => {
  for (const reuse of [false, true]) {
    const release = makeRelease({ accounts: IN8, reuse });
    const sp = spies();
    const ev = await runListingHealthV3Ingestion(liveArgs(release, sp, "india", IN8));
    ok(`3: India (8 accounts, reuse=${reuse}) proceeds past authorization + binding to paid work (frozen 14 <= 28 authorized) -- ok:true, phase complete`, ev.ok === true && ev.phase === "complete");
    ok(`3: India (reuse=${reuse}) actually reached runSources WITH the exact authorization binding (frozen reservation bound before any POST)`,
      sp.calls.runSources === 1 && sp.calls.bindings[0] && typeof sp.calls.bindings[0].bindingHash === "string" && sp.calls.bindings[0].maxTokens === 14);
    ok(`3: India (reuse=${reuse}) bound the frozen NEW tranche (lhv3-new#india), 4 creates / 14 tokens -- unchanged by reuse (reuse lowers observed creates truthfully, never the bound ceiling)`,
      sp.calls.bindings[0].trancheKey === "lhv3-new#india" && sp.calls.bindings[0].maxCreates === 4 && sp.calls.bindings[0].maxTokens === 14);
  }
})();

writeSync(1, `\nreport-listing-health-v3-authorization-binding: ${passed} assertions passed\n`);
