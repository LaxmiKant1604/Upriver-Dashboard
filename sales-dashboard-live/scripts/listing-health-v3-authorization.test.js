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
  LISTING_HEALTH_V3_PRICING_REVISION,
  LISTING_HEALTH_V3_REGION_AUTHORIZATION,
  V3_AUTHORIZED_TOKENS_PER_CREATE,
} from "../lib/server/sync/listing-health-v3-authorization.js";
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

  const au = readListingHealthV3Authorization({ region: "us-ca" });
  ok("A3: a known region reads AUTHORIZED with maxCreates/maxTokens DERIVED from maxAccounts (not a magic number)",
    au.authorized === true && au.maxAccounts === 20 && au.maxCreates === structuralRequiredCreates(20) && au.maxTokens === au.maxCreates * V3_AUTHORIZED_TOKENS_PER_CREATE && au.pricingRevision === LISTING_HEALTH_V3_PRICING_REVISION);

  const authorizedCreates = Object.keys(LISTING_HEALTH_V3_REGION_AUTHORIZATION).map((r) => readListingHealthV3Authorization({ region: r }).maxCreates).sort((a, b) => a - b);
  ok("A4: the authorization is NOT the obsolete fixed 4/8/4 (it is a membership CEILING with headroom)",
    JSON.stringify(authorizedCreates) !== JSON.stringify([4, 4, 8]) && authorizedCreates.every((c) => c >= 8));

  ok("A5: an UNKNOWN region reads no-authorization (never a silent default)", readListingHealthV3Authorization({ region: "atlantis" }).authorized === false && readListingHealthV3Authorization({ region: "atlantis" }).reason === "no-authorization");
  const stale = readListingHealthV3Authorization({ region: "us-ca", pricingRevision: "OTHER-REV" });
  ok("A6: a pricing-revision mismatch reads pricing-revision-stale (authorization is bound to pricing)", stale.authorized === false && stale.reason === "pricing-revision-stale");
  const malformed = readListingHealthV3Authorization({ region: "x", config: { x: { maxAccounts: 0, pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION } } });
  ok("A7: a malformed authorization (maxAccounts<=0) reads authorization-malformed", malformed.authorized === false && malformed.reason === "authorization-malformed");
}

/* ===================== B. pure decision: NOT derived from balance; growth defers ===================== */
{
  const authz = readListingHealthV3Authorization({ region: "us-ca" }); // maxAccounts 20, maxCreates 8, maxTokens 16
  ok("B1: within authorization -> ok", decideListingHealthV3Authorization({ region: "us-ca", accountCount: 8, requiredCreates: 4, requiredTokens: 8, authorization: authz }).ok === true);
  ok("B2: MEMBERSHIP beyond the authorized maxAccounts defers (growth never self-authorizes)",
    decideListingHealthV3Authorization({ region: "us-ca", accountCount: 21, requiredCreates: 8, requiredTokens: 16, authorization: authz }).reason === "membership-exceeds-authorization");
  ok("B3: CREATES beyond authorized maxCreates defers", decideListingHealthV3Authorization({ region: "us-ca", accountCount: 5, requiredCreates: 9, requiredTokens: 10, authorization: authz }).reason === "creates-exceed-authorization");
  ok("B4: TOKENS beyond authorized maxTokens defers", decideListingHealthV3Authorization({ region: "us-ca", accountCount: 5, requiredCreates: 2, requiredTokens: 17, authorization: authz }).reason === "tokens-exceed-authorization");
  ok("B5: an unauthorized authorization object defers with its own typed reason", decideListingHealthV3Authorization({ region: "us-ca", accountCount: 1, requiredCreates: 1, requiredTokens: 1, authorization: { authorized: false, reason: "no-authorization" } }).reason === "no-authorization");
  ok("B6: a missing authorization object defers authorization-unreadable (never a crash, never a pass)", decideListingHealthV3Authorization({ region: "us-ca", accountCount: 1, requiredCreates: 1, requiredTokens: 1, authorization: null }).reason === "authorization-unreadable");
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
  const r2 = await runListingHealthV3Ingestion(base({ ...s2, readAuthorization: async () => ({ authorized: true, maxAccounts: 1, maxCreates: 0, maxTokens: 0, pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION }) }));
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
    r4.awaitingBudget !== true && s4.calls.checkBalance === 1 && s4.calls.runSources === 1 && r4.authorizedTokens === 16 && r4.affordableTokens === 450);
})();

writeSync(1, `\nlisting-health-v3-authorization: ${passed} checks passed\n`);
