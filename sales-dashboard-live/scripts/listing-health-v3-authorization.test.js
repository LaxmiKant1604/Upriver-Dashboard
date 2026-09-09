// P1-3 reproduce-then-fix: EXPLICIT DURABLE Listing Health v3 authorization, kept SEPARATE from live affordability.
// Proves (1) the pure durable-authorization reader + decision, and (2) that the operation enforces authorization as a
// distinct gate BEFORE the affordability balance check (a failed authorization never even reads the balance), returns
// a TYPED awaiting-budget with zero creates, and never restores a fixed 4/8/4 ceiling. All collaborators injected;
// ZERO DataDoe/network/tokens. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  readListingHealthV3Authorization,
  decideListingHealthV3Authorization,
  structuralRequiredCreates,
  structuralRequiredTokens,
  V3_TOKENS_PER_BATCH,
  LISTING_HEALTH_V3_PRICING_REVISION,
  LISTING_HEALTH_V3_REGION_AUTHORIZATION,
  LISTING_HEALTH_V3_AUTHORIZATION_PROVENANCE,
  computeListingHealthV3AuthorizationBinding,
  verifyListingHealthV3ReplayBinding,
  isStrictPositiveInt,
} from "../lib/server/sync/listing-health-v3-authorization.js";
import { readFileSync } from "node:fs";
import {
  runListingHealthV3Ingestion,
  buildListingHealthV3Plan,
} from "../lib/server/sync/listing-health-v3-operation.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "listing-health-v3-authorization\n");

/* ===================== A. structural required + pure reader ===================== */
{
  ok("A1: structural required = 2 per <=5-seller batch (8 accounts -> 4, 6 -> 4, 5 -> 2, 11 -> 6)",
    structuralRequiredCreates(8) === 4 && structuralRequiredCreates(6) === 4 && structuralRequiredCreates(5) === 2 && structuralRequiredCreates(11) === 6);
  ok("A2: zero/negative account count -> zero required (no spend)", structuralRequiredCreates(0) === 0 && structuralRequiredCreates(-3) === 0);

  ok("A2b: structural TOKENS = 7 per <=5-seller batch (premium listings 5 + standard listings-raw 2): 20 accts -> 28, 35 -> 49, 11 -> 21, 8 -> 14",
    V3_TOKENS_PER_BATCH === 7 && structuralRequiredTokens(20) === 28 && structuralRequiredTokens(35) === 49 && structuralRequiredTokens(11) === 21 && structuralRequiredTokens(8) === 14);

  const au = readListingHealthV3Authorization({ region: "us-ca" });
  ok("A3: a known region reads AUTHORIZED with maxCreates + real-priced maxTokens DERIVED from maxAccounts (not a flat per-create magic number)",
    au.authorized === true && au.maxAccounts === 20 && au.maxCreates === structuralRequiredCreates(20) && au.maxTokens === structuralRequiredTokens(20) && au.maxTokens === 28 && au.pricingRevision === LISTING_HEALTH_V3_PRICING_REVISION);

  // The user-approved standing token ceilings (2026-09-10): india 28 / europe-au 49 / us-ca 28 -- real premium pricing.
  ok("A3b: all three regions read the APPROVED real-priced token ceilings (india 28 / europe-au 49 / us-ca 28); maxCreates unchanged (8/14/8)",
    readListingHealthV3Authorization({ region: "india" }).maxTokens === 28 && readListingHealthV3Authorization({ region: "india" }).maxCreates === 8
    && readListingHealthV3Authorization({ region: "europe-au" }).maxTokens === 49 && readListingHealthV3Authorization({ region: "europe-au" }).maxCreates === 14
    && readListingHealthV3Authorization({ region: "us-ca" }).maxTokens === 28 && readListingHealthV3Authorization({ region: "us-ca" }).maxCreates === 8);

  const authorizedCreates = Object.keys(LISTING_HEALTH_V3_REGION_AUTHORIZATION).map((r) => readListingHealthV3Authorization({ region: r }).maxCreates).sort((a, b) => a - b);
  ok("A4: the authorization is NOT the obsolete fixed 4/8/4 (it is a membership CEILING with headroom)",
    JSON.stringify(authorizedCreates) !== JSON.stringify([4, 4, 8]) && authorizedCreates.every((c) => c >= 8));

  ok("A5: an UNKNOWN region reads no-authorization (never a silent default)", readListingHealthV3Authorization({ region: "atlantis" }).authorized === false && readListingHealthV3Authorization({ region: "atlantis" }).reason === "no-authorization");
  const stale = readListingHealthV3Authorization({ region: "us-ca", pricingRevision: "OTHER-REV" });
  ok("A6: a pricing-revision mismatch reads pricing-revision-stale (authorization is bound to pricing)", stale.authorized === false && stale.reason === "pricing-revision-stale");
  const malformed = readListingHealthV3Authorization({ region: "x", config: { x: { maxAccounts: 0, approvedPlanTokens: 0, pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION } } });
  ok("A7: a malformed authorization (maxAccounts<=0) reads authorization-malformed", malformed.authorized === false && malformed.reason === "authorization-malformed");
  // DRIFT GUARD: a stale/mismatched explicit ceiling (e.g. the OLD flat-std2 16 left against a 20-account cap whose
  // real-priced structural is 28) is authorization-malformed -- fail closed, never a silent under-authorization.
  const drift = readListingHealthV3Authorization({ region: "us-ca", config: { "us-ca": { maxAccounts: 20, approvedPlanTokens: 16, pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION } } });
  ok("A7b: DRIFT GUARD -- an approvedPlanTokens that != the real-priced structural (16 vs 28) is authorization-malformed (the old flat-std2 defect is now caught)",
    drift.authorized === false && drift.reason === "authorization-malformed" && /16/.test(drift.detail) && /28/.test(drift.detail));
  // A missing approvedPlanTokens is malformed (the explicit reviewed ceiling is required).
  const noTokens = readListingHealthV3Authorization({ region: "x", config: { x: { maxAccounts: 20, pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION } } });
  ok("A7c: a config missing approvedPlanTokens is authorization-malformed (the explicit reviewed ceiling is required)", noTokens.authorized === false && noTokens.reason === "authorization-malformed");
}

/* ===================== B. pure decision: NOT derived from balance; growth defers ===================== */
{
  const authz = readListingHealthV3Authorization({ region: "us-ca" }); // maxAccounts 20, maxCreates 8, maxTokens 28
  ok("B1: within authorization -> ok", decideListingHealthV3Authorization({ region: "us-ca", accountCount: 8, requiredCreates: 4, requiredTokens: 8, authorization: authz }).ok === true);
  // The DEFECT-FIX case: us-ca 11 accounts / 6 creates / 21 real tokens now FITS (21 <= 28) -- the exact shape that
  // failed US natural run 34394580474 under the old flat-std2 16 ceiling.
  ok("B1b: us-ca 11 accounts / 6 creates / 21 real tokens is now WITHIN authorization (21 <= 28) -- the defect fix",
    decideListingHealthV3Authorization({ region: "us-ca", accountCount: 11, requiredCreates: 6, requiredTokens: 21, authorization: authz }).ok === true);
  ok("B2: MEMBERSHIP beyond the authorized maxAccounts defers (growth never self-authorizes)",
    decideListingHealthV3Authorization({ region: "us-ca", accountCount: 21, requiredCreates: 8, requiredTokens: 16, authorization: authz }).reason === "membership-exceeds-authorization");
  ok("B3: CREATES beyond authorized maxCreates defers", decideListingHealthV3Authorization({ region: "us-ca", accountCount: 5, requiredCreates: 9, requiredTokens: 10, authorization: authz }).reason === "creates-exceed-authorization");
  ok("B4: TOKENS beyond authorized maxTokens defers (29 > 28)", decideListingHealthV3Authorization({ region: "us-ca", accountCount: 5, requiredCreates: 2, requiredTokens: 29, authorization: authz }).reason === "tokens-exceed-authorization");
  ok("B5: an unauthorized authorization object defers with its own typed reason", decideListingHealthV3Authorization({ region: "us-ca", accountCount: 1, requiredCreates: 1, requiredTokens: 1, authorization: { authorized: false, reason: "no-authorization" } }).reason === "no-authorization");
  ok("B6: a missing authorization object defers authorization-unreadable (never a crash, never a pass)", decideListingHealthV3Authorization({ region: "us-ca", accountCount: 1, requiredCreates: 1, requiredTokens: 1, authorization: null }).reason === "authorization-unreadable");

  // ALL REGIONS at CURRENT membership (india 8->14 tok, europe-au 30->42, us-ca 11->21) are authorized under 28/49/28.
  const cur = [["india", 8, 4, 14], ["europe-au", 30, 12, 42], ["us-ca", 11, 6, 21]];
  ok("B7: every region at CURRENT membership is authorized under the approved ceilings (india 14<=28, europe-au 42<=49, us-ca 21<=28)",
    cur.every(([r, n, c, t]) => decideListingHealthV3Authorization({ region: r, accountCount: n, requiredCreates: c, requiredTokens: t, authorization: readListingHealthV3Authorization({ region: r }) }).ok === true));
  // ALL REGIONS at the APPROVED account CAP (20/35/20) fit EXACTLY (28/49/28).
  const caps = [["india", 20, 8, 28], ["europe-au", 35, 14, 49], ["us-ca", 20, 8, 28]];
  ok("B8: every region at the APPROVED account cap fits its ceiling EXACTLY (india 28, europe-au 49, us-ca 28)",
    caps.every(([r, n, c, t]) => decideListingHealthV3Authorization({ region: r, accountCount: n, requiredCreates: c, requiredTokens: t, authorization: readListingHealthV3Authorization({ region: r }) }).ok === true));
  // cap+1 accounts defers (membership-exceeds) for every region -- growth beyond the reviewed cap never self-authorizes.
  const capPlus = [["india", 21], ["europe-au", 36], ["us-ca", 21]];
  ok("B9: every region at cap+1 accounts defers membership-exceeds-authorization (growth never self-raises the ceiling)",
    capPlus.every(([r, n]) => decideListingHealthV3Authorization({ region: r, accountCount: n, requiredCreates: 2, requiredTokens: 2, authorization: readListingHealthV3Authorization({ region: r }) }).reason === "membership-exceeds-authorization"));
}

/* ===================== C. operation: authorization is a SEPARATE gate BEFORE affordability ===================== */
const connections = [{ id: "primary", apiKey: "k", accountPrefix: "" }];
const cycleDate = "2026-09-04";
const usAccounts = ["acct-00", "acct-01"].map((id, i) => ({ accountId: id, country: "US", currency: "USD", name: `A${i}` }));
function spies({ balance = { usable: 1000 } } = {}) {
  const calls = { checkBalance: 0, runSources: 0, materialize: 0, runReports: 0, finalizeCycle: 0 };
  return {
    calls,
    discoverAccounts: async () => usAccounts,
    buildPlan: (args) => buildListingHealthV3Plan(args),
    resolveCost: async () => ({ newExports: 2, reusedExports: 1, creates: 2, estimatedTokens: 4, inventoryAdoptable: true }),
    checkBalance: async () => { calls.checkBalance += 1; return balance; },
    freezeBudget: async () => ({ planFingerprint: "fp-test", maxCreates: 2, maxTokens: 4, hashes: [{ requestHash: "h1", tokenCost: 2 }, { requestHash: "h2", tokenCost: 2 }] }), readFrozenBudget: async () => null,
    runSources: async () => { calls.runSources += 1; return { drained: true, creates: 2, tokens: 4, inventoryCreated: false }; },
    materialize: async () => { calls.materialize += 1; return { accounts: 2, aliasesWritten: 2, emptyAliases: 0, rejected: 0, skippedStale: 0 }; },
    runReports: async () => { calls.runReports += 1; return { succeeded: 2, blocked: 0, failed: 0, drained: true }; },
    finalizeCycle: async () => { calls.finalizeCycle += 1; return { disposition: "finalized", status: "succeeded", cycleId: "cyc-1" }; },
  };
}
const base = (over = {}) => ({ region: "us-ca", cycleDate, connections, authorized: true, mode: "live", gate: { enabled: true }, ...over });

await (async () => {
  // (a) NO authorization -> awaiting-budget, and the balance is NEVER read (authorization is upstream of affordability).
  const s = spies();
  const r = await runListingHealthV3Ingestion(base({ ...s, readAuthorization: async () => ({ authorized: false, reason: "no-authorization" }) }));
  ok("C1: an unauthorized region returns TYPED awaiting-budget (no-authorization), zero creates, LKG preserved",
    r.ok === false && r.phase === "awaiting-budget" && r.awaitingBudget === true && r.deferred === true && r.authorizationReason === "no-authorization" && r.creates === 0 && r.tokens === 0);
  ok("C2: a failed AUTHORIZATION never even reads the affordability balance (separate, ordered gates)", s.calls.checkBalance === 0 && s.calls.runSources === 0);

  // (b) authorization present but membership exceeds it -> awaiting-budget membership-exceeds, still before balance.
  const s2 = spies();
  const r2 = await runListingHealthV3Ingestion(base({ ...s2, readAuthorization: async () => ({ authorized: true, region: "us-ca", maxAccounts: 1, maxCreates: 2, maxTokens: 4, pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION }) }));
  ok("C3: membership beyond the durable authorization defers (growth never self-authorizes) before any balance/source work",
    r2.phase === "awaiting-budget" && r2.authorizationReason === "membership-exceeds-authorization" && s2.calls.checkBalance === 0 && s2.calls.runSources === 0);

  // (c) a pricing-revision mismatch (operation pricingRevision != authorized) defers pricing-revision-stale.
  const s3 = spies();
  const r3 = await runListingHealthV3Ingestion(base({ ...s3, pricingRevision: "STALE-REV" }));
  ok("C4: a stale pricing revision defers pricing-revision-stale (authorization bound to pricing) before balance",
    r3.phase === "awaiting-budget" && r3.authorizationReason === "pricing-revision-stale" && s3.calls.checkBalance === 0);

  // (d) real default authorization (us-ca, 2 accounts) + affordable balance -> passes authorization AND affordability.
  const s4 = spies({ balance: { usable: 500, reserve: 50 } });
  const r4 = await runListingHealthV3Ingestion(base({ ...s4 }));
  ok("C5: the real durable authorization (us-ca) with an affordable balance proceeds (both gates pass; runs sources)",
    r4.awaitingBudget !== true && s4.calls.checkBalance === 1 && s4.calls.runSources === 1 && r4.authorizedTokens === 28 && r4.affordableTokens === 450);
})();


/* ===================== D. EXACT per-cycle BINDING of the STANDING regional authorization (round 2) ===================== */
{
  ok("D0: the limits are a STANDING regional policy with recorded provenance (origin 90d981e + the 2026-09-10 reviewed token-ceiling raise); account caps UNCHANGED (20/35/20); approved token ceilings 28/49/28",
    LISTING_HEALTH_V3_AUTHORIZATION_PROVENANCE.kind === "standing-regional-limit" && /90d981e/.test(LISTING_HEALTH_V3_AUTHORIZATION_PROVENANCE.approvedIn) && /2026-09-10/.test(LISTING_HEALTH_V3_AUTHORIZATION_PROVENANCE.approvedIn)
    && LISTING_HEALTH_V3_REGION_AUTHORIZATION.india.maxAccounts === 20 && LISTING_HEALTH_V3_REGION_AUTHORIZATION["europe-au"].maxAccounts === 35 && LISTING_HEALTH_V3_REGION_AUTHORIZATION["us-ca"].maxAccounts === 20
    && LISTING_HEALTH_V3_REGION_AUTHORIZATION.india.approvedPlanTokens === 28 && LISTING_HEALTH_V3_REGION_AUTHORIZATION["europe-au"].approvedPlanTokens === 49 && LISTING_HEALTH_V3_REGION_AUTHORIZATION["us-ca"].approvedPlanTokens === 28
    && /ESTIMATE/.test(LISTING_HEALTH_V3_AUTHORIZATION_PROVENANCE.tokensNote));

  const authz = readListingHealthV3Authorization({ region: "us-ca" });
  const frozen = { trancheKey: "lhv3-new#us-ca", planFingerprint: "fp-A", maxCreates: 4, maxTokens: 8, hashes: [{ requestHash: "h-b" }, { requestHash: "h-a" }, { requestHash: "h-d" }, { requestHash: "h-c" }] };
  const args = { region: "us-ca", cycleDate: "2026-09-08", operationId: "listing-health-v3/us-ca/2026-09-08", trancheKey: "lhv3-new#us-ca", accountIds: ["A2", "A1", "A3"], frozen, pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION, authorization: authz };
  const b1 = computeListingHealthV3AuthorizationBinding(args);
  ok("D1: a NEW frozen cycle within the standing limits binds OK (no daily manual approval): region+cycle+operation+tranche+membership+hashes+fingerprint+pricing all bound",
    b1.ok === true && b1.binding.region === "us-ca" && b1.binding.cycleDate === "2026-09-08" && b1.binding.operationId === args.operationId && b1.binding.trancheKey === "lhv3-new#us-ca"
    && b1.binding.planFingerprint === "fp-A" && b1.binding.pricingRevision === LISTING_HEALTH_V3_PRICING_REVISION && /^[0-9a-f]{64}$/.test(b1.binding.bindingHash)
    && JSON.stringify([...b1.binding.requestHashes]) === JSON.stringify(["h-a", "h-b", "h-c", "h-d"]) && b1.binding.accountCount === 3);
  const b1b = computeListingHealthV3AuthorizationBinding({ ...args, accountIds: ["A3", "A1", "A2"], frozen: { ...frozen, hashes: [...frozen.hashes].reverse() } });
  ok("D2: the binding is DETERMINISTIC over membership/hash ORDER (same bindingHash)", b1b.ok && b1b.binding.bindingHash === b1.binding.bindingHash);
  ok("D3: a different cycle date / operation / fingerprint / membership / hash set / pricing changes the bindingHash",
    computeListingHealthV3AuthorizationBinding({ ...args, cycleDate: "2026-09-09", operationId: "x/2026-09-09" }).binding.bindingHash !== b1.binding.bindingHash
    && computeListingHealthV3AuthorizationBinding({ ...args, frozen: { ...frozen, planFingerprint: "fp-B" } }).binding.bindingHash !== b1.binding.bindingHash
    && computeListingHealthV3AuthorizationBinding({ ...args, accountIds: ["A1", "A2"] }).binding.bindingHash !== b1.binding.bindingHash
    && computeListingHealthV3AuthorizationBinding({ ...args, frozen: { ...frozen, hashes: [{ requestHash: "h-a" }, { requestHash: "h-b" }, { requestHash: "h-c" }, { requestHash: "h-z" }] } }).binding.bindingHash !== b1.binding.bindingHash);

  ok("D4: an authorization for the WRONG region never binds (authorization-region-mismatch)",
    computeListingHealthV3AuthorizationBinding({ ...args, authorization: readListingHealthV3Authorization({ region: "india" }) }).reason === "authorization-region-mismatch"
    && decideListingHealthV3Authorization({ region: "us-ca", accountCount: 1, requiredCreates: 2, requiredTokens: 4, authorization: readListingHealthV3Authorization({ region: "india" }) }).reason === "authorization-region-mismatch");
  ok("D5: a pricing revision that differs from the request never binds (pricing-revision-stale)",
    computeListingHealthV3AuthorizationBinding({ ...args, pricingRevision: "OTHER" }).reason === "pricing-revision-stale"
    && decideListingHealthV3Authorization({ region: "us-ca", accountCount: 1, requiredCreates: 2, requiredTokens: 4, authorization: authz, pricingRevision: "OTHER" }).reason === "pricing-revision-stale");
  ok("D6: a frozen plan whose creates/tokens exceed the standing limits does NOT bind (creates-exceed-authorization); the limits never self-raise",
    computeListingHealthV3AuthorizationBinding({ ...args, frozen: { ...frozen, maxCreates: 9, maxTokens: 18, hashes: Array.from({ length: 9 }, (_, i) => ({ requestHash: "h" + i })) } }).reason === "creates-exceed-authorization");
  ok("D7: STRICT numerics -- a numeric STRING / float / NaN limit is authorization-malformed; a string request count is request-malformed",
    readListingHealthV3Authorization({ region: "x", config: { x: { maxAccounts: "20", pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION } } }).reason === "authorization-malformed"
    && readListingHealthV3Authorization({ region: "x", config: { x: { maxAccounts: 2.5, pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION } } }).reason === "authorization-malformed"
    && decideListingHealthV3Authorization({ region: "us-ca", accountCount: 1, requiredCreates: "2", requiredTokens: 4, authorization: authz }).reason === "request-malformed"
    && decideListingHealthV3Authorization({ region: "us-ca", accountCount: 1, requiredCreates: 2, requiredTokens: 4, authorization: { ...authz, maxTokens: NaN } }).reason === "authorization-malformed"
    && isStrictPositiveInt("20") === false && isStrictPositiveInt(20) === true);
  ok("D8: a frozen budget whose hash count differs from its maxCreates is binding-malformed (never bound)",
    computeListingHealthV3AuthorizationBinding({ ...args, frozen: { ...frozen, maxCreates: 3 } }).reason === "binding-malformed");

  // replay verification against the DURABLE frozen budget row
  const persistedExact = { row: { plan_fingerprint: "fp-A", max_creates: 4, max_tokens: 8 }, hashes: [{ request_hash: "h-d" }, { request_hash: "h-c" }, { request_hash: "h-b" }, { request_hash: "h-a" }] };
  ok("D9: REPLAY with an EXACTLY matching persisted frozen budget verifies (replay:true); a NEW cycle (null) is ok (replay:false)",
    verifyListingHealthV3ReplayBinding({ binding: b1.binding, persisted: persistedExact }).ok === true && verifyListingHealthV3ReplayBinding({ binding: b1.binding, persisted: persistedExact }).replay === true
    && verifyListingHealthV3ReplayBinding({ binding: b1.binding, persisted: null }).ok === true && verifyListingHealthV3ReplayBinding({ binding: b1.binding, persisted: null }).replay === false);
  const fpDrift = verifyListingHealthV3ReplayBinding({ binding: b1.binding, persisted: { ...persistedExact, row: { ...persistedExact.row, plan_fingerprint: "fp-OLD" } } });
  const hashDrift = verifyListingHealthV3ReplayBinding({ binding: b1.binding, persisted: { ...persistedExact, hashes: persistedExact.hashes.slice(0, 3) } });
  const ceilDrift = verifyListingHealthV3ReplayBinding({ binding: b1.binding, persisted: { ...persistedExact, row: { ...persistedExact.row, max_tokens: 10 } } });
  ok("D10: REPLAY mismatch on fingerprint / hash set / ceilings is a typed replay-binding-mismatch (awaiting-budget, never paid work)",
    fpDrift.ok === false && fpDrift.reason === "replay-binding-mismatch" && /plan-fingerprint/.test(fpDrift.detail)
    && hashDrift.ok === false && /request-hashes/.test(hashDrift.detail) && ceilDrift.ok === false && /max-tokens/.test(ceilDrift.detail));

  // OLD-CYCLE COMPATIBLE REPLAY (defect 1 old-cycle handling): a prior terminal cycle's REAL-priced frozen budget
  // (computeFrozenTrancheBudget is UNCHANGED -- premium listings 5 + standard raw 2) still BINDS and REPLAYS under the
  // RAISED ceiling. Raising the ceiling only WIDENS the band (14 <= 28), never shrinks a frozen reservation; and the
  // pricing-revision string is NOT part of the persisted replay comparison (fingerprint/creates/tokens/hashes only),
  // so no old frozen cycle is refused, rewritten, or re-authorized.
  const canaryAuthz = readListingHealthV3Authorization({ region: "us-ca" }); // now 28 tokens / 8 creates
  const canaryFrozen = { trancheKey: "lhv3-new#us-ca", planFingerprint: "fp-canary", maxCreates: 4, maxTokens: 14, hashes: [{ requestHash: "c1" }, { requestHash: "c2" }, { requestHash: "c3" }, { requestHash: "c4" }] };
  const canaryBind = computeListingHealthV3AuthorizationBinding({ region: "us-ca", cycleDate: "2026-09-06", operationId: "listing-health-v3/us-ca/2026-09-06", trancheKey: "lhv3-new#us-ca", accountIds: Array.from({ length: 10 }, (_, i) => "u" + i), frozen: canaryFrozen, pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION, authorization: canaryAuthz });
  ok("D11: an OLD real-priced canary frozen budget (4 creates / 14 tokens) STILL binds under the RAISED 28 ceiling (a widened band never shrinks a frozen reservation)",
    canaryBind.ok === true && canaryBind.binding.maxTokens === 14 && canaryBind.binding.maxCreates === 4);
  const canaryPersisted = { row: { plan_fingerprint: "fp-canary", max_creates: 4, max_tokens: 14 }, hashes: [{ request_hash: "c4" }, { request_hash: "c3" }, { request_hash: "c2" }, { request_hash: "c1" }] };
  const canaryReplay = verifyListingHealthV3ReplayBinding({ binding: canaryBind.binding, persisted: canaryPersisted });
  ok("D11: the OLD canary's persisted frozen budget replays EXACTLY (replay:true) -- the pricing-revision change is not part of the persisted comparison; no old cycle is rewritten",
    canaryReplay.ok === true && canaryReplay.replay === true);
}

/* ===================== E. the OPERATION enforces the binding BEFORE affordability and hands it to runSources ===================== */
{
  const mk = (over = {}) => {
    const calls = { checkBalance: 0, runSources: 0, bindingSeen: null };
    return { calls, collab: {
      discoverAccounts: async () => [{ accountId: "U1", country: "US", currency: "USD", name: "U1" }, { accountId: "U2", country: "CA", currency: "CAD", name: "U2" }],
      buildPlan: (args) => buildListingHealthV3Plan(args),
      resolveCost: async () => ({ newExports: 2, reusedExports: 1, creates: 2, estimatedTokens: 4, inventoryAdoptable: true }),
      checkBalance: async () => { calls.checkBalance += 1; return { usable: 500 }; },
      runSources: async ({ authorizationBinding }) => { calls.runSources += 1; calls.bindingSeen = authorizationBinding; return { drained: true, creates: 2, tokens: 4, inventoryCreated: false }; },
      materialize: async () => ({ accounts: 2, aliasesWritten: 2, emptyAliases: 0, rejected: 0, skippedStale: 0 }),
      runReports: async () => ({ succeeded: 2, blocked: 0, failed: 0, drained: true }),
      finalizeCycle: async () => ({ disposition: "finalized", status: "succeeded", cycleId: "cyc-1" }),
      freezeBudget: async () => ({ trancheKey: "lhv3-new#us-ca", planFingerprint: "fp-live", maxCreates: 2, maxTokens: 4, hashes: [{ requestHash: "h1", tokenCost: 2 }, { requestHash: "h2", tokenCost: 2 }] }),
      readFrozenBudget: async () => null,
      ...over,
    } };
  };
  const liveBase = (collab, over = {}) => ({ region: "us-ca", cycleDate: "2026-09-08", connections: [{ id: "primary", apiKey: "k", accountPrefix: "" }], authorized: true, mode: "live", gate: { enabled: true }, ...collab, ...over });

  const m1 = mk({ freezeBudget: undefined });
  const r1 = await runListingHealthV3Ingestion(liveBase(m1.collab));
  ok("E1: a live run WITHOUT the binding collaborator returns typed awaiting-budget (binding-unavailable) BEFORE the balance read and before any source work",
    r1.phase === "awaiting-budget" && r1.authorizationReason === "binding-unavailable" && r1.creates === 0 && m1.calls.checkBalance === 0 && m1.calls.runSources === 0);

  const m2 = mk();
  const r2 = await runListingHealthV3Ingestion(liveBase(m2.collab));
  ok("E2: a NEW frozen cycle within the standing limits proceeds and runSources RECEIVES the exact binding (bindingHash, region, cycleDate, tranche, fingerprint, hashes)",
    r2.awaitingBudget !== true && m2.calls.runSources === 1 && m2.calls.bindingSeen && /^[0-9a-f]{64}$/.test(m2.calls.bindingSeen.bindingHash)
    && m2.calls.bindingSeen.region === "us-ca" && m2.calls.bindingSeen.cycleDate === "2026-09-08" && m2.calls.bindingSeen.trancheKey === "lhv3-new#us-ca"
    && m2.calls.bindingSeen.planFingerprint === "fp-live" && JSON.stringify([...m2.calls.bindingSeen.requestHashes]) === JSON.stringify(["h1", "h2"])
    && r2.authorizationBinding && r2.authorizationBinding.replay === false && r2.authorizationBinding.estimatedTokens === 4);

  const m3 = mk({ readFrozenBudget: async () => ({ row: { plan_fingerprint: "fp-YESTERDAY", max_creates: 2, max_tokens: 4 }, hashes: [{ request_hash: "h1" }, { request_hash: "h2" }] }) });
  const r3 = await runListingHealthV3Ingestion(liveBase(m3.collab));
  ok("E3: REPLAY against a persisted frozen budget that does NOT match exactly returns awaiting-budget (replay-binding-mismatch) before balance/source work",
    r3.phase === "awaiting-budget" && r3.authorizationReason === "replay-binding-mismatch" && m3.calls.checkBalance === 0 && m3.calls.runSources === 0);

  const m3b = mk({ readFrozenBudget: async () => ({ row: { plan_fingerprint: "fp-live", max_creates: 2, max_tokens: 4 }, hashes: [{ request_hash: "h2" }, { request_hash: "h1" }] }) });
  const r3b = await runListingHealthV3Ingestion(liveBase(m3b.collab));
  ok("E4: an EXACT replay (same fingerprint/ceilings/hash set) proceeds with replay:true (a watchdog re-run resumes, never re-authorizes)",
    r3b.awaitingBudget !== true && m3b.calls.runSources === 1 && r3b.authorizationBinding.replay === true);

  const m4 = mk({ readAuthorization: async () => ({ ...readListingHealthV3Authorization({ region: "india" }) }) });
  const r4 = await runListingHealthV3Ingestion(liveBase(m4.collab, { readAuthorization: m4.collab.readAuthorization }));
  ok("E5: an authorization for another region (india) never authorizes a us-ca run (authorization-region-mismatch)", r4.phase === "awaiting-budget" && r4.authorizationReason === "authorization-region-mismatch" && m4.calls.runSources === 0);

  const m5 = mk({ freezeBudget: async () => ({ trancheKey: "lhv3-new#us-ca", planFingerprint: "fp-big", maxCreates: 10, maxTokens: 20, hashes: Array.from({ length: 10 }, (_, i) => ({ requestHash: "h" + i, tokenCost: 2 })) }) });
  const r5 = await runListingHealthV3Ingestion(liveBase(m5.collab));
  ok("E6: a frozen plan exceeding the standing us-ca limit (10 > 8 creates) is awaiting-budget (creates-exceed-authorization) before any paid work", r5.phase === "awaiting-budget" && r5.authorizationReason === "creates-exceed-authorization" && m5.calls.runSources === 0);

  const m6 = mk({ readFrozenBudget: async () => { throw new Error("db down"); } });
  const r6 = await runListingHealthV3Ingestion(liveBase(m6.collab));
  ok("E7: an UNREADABLE durable frozen budget defers typed (frozen-budget-unreadable) -- never treated as a new cycle", r6.phase === "awaiting-budget" && r6.authorizationReason === "frozen-budget-unreadable" && m6.calls.runSources === 0);

  const cli = readFileSync(new URL("./release/listing-health-v3-ingestion.mjs", import.meta.url), "utf8");
  const comp = readFileSync(new URL("../lib/server/sync/listing-health-v3-ingestion-composition.js", import.meta.url), "utf8");
  ok("E8: the scheduled CLI hands the composition's freezeBudget + readFrozenBudget to the operation, and the composition's runSources refuses a missing/mismatched binding before any cycle/reservation/POST",
    /freezeBudget: release\.freezeBudget/.test(cli) && /readFrozenBudget: release\.readFrozenBudget/.test(cli)
    && /AUTHORIZATION_BINDING_MISSING/.test(comp) && /AUTHORIZATION_BINDING_MISMATCH/.test(comp));
}

writeSync(1, `\nlisting-health-v3-authorization: ${passed} checks passed\n`);
