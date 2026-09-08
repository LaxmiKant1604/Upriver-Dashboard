// Listing Health v3 FUTURE ACCOUNT-IDENTITY guard -- Phase 3.
//
// The per-account read hash is marketplace-INDEPENDENT, so two DISTINCT account records that share a rawSellerId
// within one connection (a future pan-EU seller id connected as multiple marketplace accounts) would resolve to ONE
// read identity and cross-contaminate aliases. The guard must detect that BEFORE any export create, fail closed with
// zero creates, and name ONLY safe public account-id prefixes (never the rawSellerId / apiKey / marketplace). ZERO
// DataDoe/network. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { assertNoDuplicatePerAccountReadIdentities } from "../lib/server/sync/listing-health-v3-materialize.js";
import { runListingHealthV3Ingestion } from "../lib/server/sync/listing-health-v3-operation.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "report-listing-health-v3-identity-guard\n");

const API_KEY = "fixture-key";
const connections = [{ id: "primary", apiKey: API_KEY, accountPrefix: "" }];
const req = (accountId, rawSellerId, marketplace) => ({ reportKey: "listing-health-v3", owner: { accountId, rawSellerId, connectionId: "primary", marketplace }, sources: [] });

/* ===================== A. distinct rawSellerIds -> no collision ===================== */
(() => {
  const v3Requests = [req("acct-DE", "SELLER-DE", "DE"), req("acct-FR", "SELLER-FR", "FR"), req("acct-UK", "SELLER-UK", "UK")];
  const res = assertNoDuplicatePerAccountReadIdentities({ v3Requests, connections });
  ok("A: unique rawSellerIds pass the guard (one identity per account)", res.checked === 3 && res.distinctIdentities === 3);
})();

/* ===================== B. a FUTURE pan-EU seller id in multiple marketplaces -> fail closed ===================== */
(() => {
  // Same rawSellerId, two DISTINCT account records + marketplaces (DE + FR) -> one marketplace-independent read hash.
  const v3Requests = [req("acct-DE-9a1", "PANEU-SELLER-1", "DE"), req("acct-FR-7b2", "PANEU-SELLER-1", "FR")];
  let threw = null;
  try { assertNoDuplicatePerAccountReadIdentities({ v3Requests, connections }); } catch (e) { threw = e; }
  ok("B: a shared rawSellerId across two accounts/marketplaces THROWS (fail closed)", threw instanceof Error);
  const msg = String(threw && threw.message);
  ok("B: the diagnostic names BOTH safe account-id prefixes", msg.includes("acct-DE-") && msg.includes("acct-FR-"));
  ok("B: the diagnostic leaks NEITHER the rawSellerId NOR the apiKey (only safe account-id prefixes)", !msg.includes("PANEU-SELLER-1") && !msg.includes(API_KEY));
  ok("B: the message says it is refusing with zero creates", /fail closed|zero creates|refus/i.test(msg));
})();

/* ===================== C. three-way collision names all three accounts ===================== */
(() => {
  const v3Requests = [req("aaa11111", "WHALE", "DE"), req("bbb22222", "WHALE", "FR"), req("ccc33333", "WHALE", "IT")];
  let msg = "";
  try { assertNoDuplicatePerAccountReadIdentities({ v3Requests, connections }); } catch (e) { msg = String(e.message); }
  ok("C: a 3-way rawSellerId collision names all three account prefixes", msg.includes("aaa11111") && msg.includes("bbb22222") && msg.includes("ccc33333"));
})();

/* ===================== D. operator integration: a colliding plan fails closed BEFORE any source create ===================== */
await (async () => {
  const calls = { runSources: 0, materialize: 0, runReports: 0, finalizeCycle: 0 };
  const collab = {
    discoverAccounts: async () => [{ accountId: "acct-DE-9a1", country: "DE", currency: "EUR" }, { accountId: "acct-FR-7b2", country: "FR", currency: "EUR" }],
    // Inject a plan whose two requests SHARE a rawSellerId (the future pan-EU case) -- the real planner cannot easily
    // produce this today, so we force it to prove the operator invokes the guard before any create.
    buildPlan: () => ({ reportRequests: [req("acct-DE-9a1", "PANEU-SELLER-1", "DE"), req("acct-FR-7b2", "PANEU-SELLER-1", "FR")] }),
    resolveCost: async () => ({ newExports: 4, reusedExports: 2, creates: 4, estimatedTokens: 8, inventoryAdoptable: true }),
    checkBalance: async () => ({ usable: 1000 }),
    freezeBudget: async () => ({ planFingerprint: "fp-test", maxCreates: 2, maxTokens: 4, hashes: [{ requestHash: "h1", tokenCost: 2 }, { requestHash: "h2", tokenCost: 2 }] }), readFrozenBudget: async () => null,
    runSources: async () => { calls.runSources += 1; return { drained: true, creates: 4, inventoryCreated: false }; },
    materialize: async () => { calls.materialize += 1; return { rejected: 0 }; },
    runReports: async () => { calls.runReports += 1; return { succeeded: 2, blocked: 0, failed: 0, drained: true }; },
    finalizeCycle: async () => { calls.finalizeCycle += 1; return { disposition: "finalized", status: "succeeded" }; },
  };
  const r = await runListingHealthV3Ingestion({ region: "europe-au", cycleDate: "2026-09-05", connections, authorized: true, mode: "live", gate: { enabled: true }, ...collab });
  ok("D: the operator fails closed at phase 'identity' on a colliding plan", r.ok === false && r.phase === "identity");
  ok("D: ZERO source/report/finalize work happened (no creates)", calls.runSources === 0 && calls.materialize === 0 && calls.runReports === 0 && calls.finalizeCycle === 0);
  // Even a DRY-RUN surfaces the collision (the guard runs before the dry-run planned return).
  const rDry = await runListingHealthV3Ingestion({ region: "europe-au", cycleDate: "2026-09-05", connections, authorized: true, mode: "dry-run", gate: { enabled: false }, ...collab });
  ok("D: a dry-run also surfaces the identity collision (guard runs before any planned return)", rDry.ok === false && rDry.phase === "identity");
})();

writeSync(1, `\nreport-listing-health-v3-identity-guard: ${passed} assertions passed\n`);
