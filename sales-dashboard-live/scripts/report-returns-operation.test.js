// Returns & Refund Leakage -- dedicated operator: batching + token contract + idempotency + isolation (offline, DI).
//
// Proves the token/batch contract EXACTLY: <=5 sellers/batch, never mixing US/Non-US, 2 exports/batch @ 2 tokens =>
// US(8 accts)=8 tokens, Non-US(22)=20; a plan over the ceiling STOPS before any create; an insufficient balance is a
// typed SAFE skip (LKG intact); a fallback after full coverage is a ZERO-token no-op (primary/fallback idempotency);
// a failed batch preserves LKG for its accounts; dry-run creates/writes nothing; the initial settlement window starts
// at the 2026-07-01 floor and the daily window is 21 days.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { runReturnsBucketCycle } from "../lib/server/sync/returns-operation.js";
import { tokenGateDecision } from "../lib/server/datadoe-usage.js";
import { RETURNS, SETTLEMENTS } from "../lib/server/reports/sources.js";
import { addDaysStr } from "../lib/server/datadoe.js";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

const ASOF = "2026-08-30";
const bucketForCountry = (c) => (String(c || "").toUpperCase() === "US" ? "us" : "non-us");
const mkAccounts = (n, country) => Array.from({ length: n }, (_, i) => ({
  accountId: `${country}-${String(i).padStart(2, "0")}`, sellerOrVendorId: `${country}-${String(i).padStart(2, "0")}`,
  country, marketplaceCountryCode: country, currency: country === "US" ? "USD" : "EUR", connectionId: "primary",
  organizationFingerprint: "org", name: `${country} ${i}`,
}));

function makeDeps({ accounts, coverage = new Map(), balance = 1000, failBatchIndex = -1 } = {}) {
  const calls = { fetchExport: [], replaceReturns: [], replaceSettlements: [], published: [] };
  let batchSeen = 0;
  return {
    calls,
    listAccounts: async () => accounts,
    bucketForCountry,
    readCoverage: async () => coverage,
    getTokenBalance: async () => ({ read: "ok", usable: balance }),
    tokenGate: tokenGateDecision,
    fetchExport: async ({ sourceId, columns, ids, from, to, options, label }) => {
      const idx = batchSeen; // Returns then Settlements share a batch index bump on the Returns call
      if (label === "Returns") { if (idx === failBatchIndex) { batchSeen += 1; throw new Error("simulated Returns export failure"); } }
      const rec = { sourceId, ids: [...ids], from, to, label };
      calls.fetchExport.push(rec);
      if (label === "Settlements") batchSeen += 1;
      return { rows: [], exportId: "e_" + label + "_" + idx, requestHash: "h_" + label + "_" + idx };
    },
    replaceReturns: async (a) => { calls.replaceReturns.push(a); return { write: "ok" }; },
    replaceSettlements: async (a) => { calls.replaceSettlements.push(a); return { write: "ok" }; },
    publishAccount: async ({ account }) => { calls.published.push(account.accountId); return { published: true }; },
    log: () => {},
  };
}

test("1. dry-run proves the plan with ZERO creates/writes; US(8)=8 tokens, Non-US(22)=20 tokens", async () => {
  const us = makeDeps({ accounts: mkAccounts(8, "US") });
  const rUs = await runReturnsBucketCycle({ bucket: "us", asOf: ASOF, mode: "dry-run", deps: us });
  assert.equal(rUs.batches, 2, "8 US -> 2 batches");
  assert.equal(rUs.plannedTokens, 8, "US ceiling-hitting plan = 8 tokens");
  assert.equal(us.calls.fetchExport.length, 0, "dry-run creates nothing");
  assert.equal(us.calls.replaceReturns.length, 0, "dry-run writes nothing");

  const nu = makeDeps({ accounts: mkAccounts(22, "IN") });
  const rNu = await runReturnsBucketCycle({ bucket: "non-us", asOf: ASOF, mode: "dry-run", deps: nu });
  assert.equal(rNu.batches, 5, "22 Non-US -> 5 batches");
  assert.equal(rNu.plannedTokens, 20, "Non-US plan = 20 tokens");
});

test("2. go-live US spends EXACTLY 8 tokens (2 batches x 2 exports x 2), <=5 sellers/batch, 16 durable writes, 8 published", async () => {
  const deps = makeDeps({ accounts: mkAccounts(8, "US") });
  const r = await runReturnsBucketCycle({ bucket: "us", asOf: ASOF, mode: "go-live", deps });
  assert.equal(r.creates, 4, "4 exports");
  assert.equal(r.tokens, 8, "8 tokens exactly");
  assert.equal(deps.calls.fetchExport.length, 4);
  for (const c of deps.calls.fetchExport) assert.ok(c.ids.length <= 5, "<=5 sellers/batch");
  assert.equal(deps.calls.replaceReturns.length, 8);
  assert.equal(deps.calls.replaceSettlements.length, 8);
  assert.equal(r.published, 8);
  assert.equal(r.outcome, "COMPLETED");
});

test("3. go-live Non-US spends EXACTLY 20 tokens (5 batches), 22 published", async () => {
  const deps = makeDeps({ accounts: mkAccounts(22, "IN") });
  const r = await runReturnsBucketCycle({ bucket: "non-us", asOf: ASOF, mode: "go-live", deps });
  assert.equal(r.creates, 10);
  assert.equal(r.tokens, 20);
  assert.equal(r.published, 22);
});

test("4. a plan OVER the ceiling STOPS before any create (TOKEN_CEILING_EXCEEDED)", async () => {
  const deps = makeDeps({ accounts: mkAccounts(11, "US") }); // 3 batches -> 12 tokens > US ceiling 8
  const r = await runReturnsBucketCycle({ bucket: "us", asOf: ASOF, mode: "go-live", deps });
  assert.equal(r.outcome, "TOKEN_CEILING_EXCEEDED");
  assert.equal(deps.calls.fetchExport.length, 0, "zero creates when over the ceiling");
});

test("5. an insufficient balance is a typed SAFE skip (SKIPPED_INSUFFICIENT_TOKENS), zero creates, LKG intact", async () => {
  const deps = makeDeps({ accounts: mkAccounts(8, "US"), balance: 5 }); // need 8, have 5
  const r = await runReturnsBucketCycle({ bucket: "us", asOf: ASOF, mode: "go-live", deps });
  assert.equal(r.outcome, "SKIPPED_INSUFFICIENT_TOKENS");
  assert.equal(deps.calls.fetchExport.length, 0);
  assert.equal(deps.calls.replaceReturns.length, 0);
});

test("6. a fallback after full coverage is a ZERO-token no-op that still publishes (primary/fallback idempotency)", async () => {
  const accounts = mkAccounts(8, "US");
  const coverage = new Map(accounts.map((a) => [a.accountId, { returnsMax: ASOF, settlementMax: ASOF, settlementMin: "2026-07-01" }]));
  const deps = makeDeps({ accounts, coverage });
  const r = await runReturnsBucketCycle({ bucket: "us", asOf: ASOF, mode: "go-live", deps });
  assert.equal(r.tokens, 0, "zero tokens on a fully-covered replay");
  assert.equal(deps.calls.fetchExport.length, 0, "zero creates");
  assert.equal(r.published, 8, "still refreshes every snapshot from durable (idempotent)");
  assert.equal(r.outcome, "COMPLETED_ALREADY_COVERED");
});

test("7. never mixes buckets: a us run over a mixed roster fetches ONLY US accounts", async () => {
  const accounts = [...mkAccounts(8, "US"), ...mkAccounts(22, "IN")];
  const deps = makeDeps({ accounts });
  const r = await runReturnsBucketCycle({ bucket: "us", asOf: ASOF, mode: "go-live", deps });
  assert.equal(r.accounts, 8, "only US in scope");
  assert.equal(r.tokens, 8);
  for (const c of deps.calls.fetchExport) for (const id of c.ids) assert.ok(id.startsWith("US-"), "no Non-US id in a US batch");
  assert.equal(r.published, 8);
});

test("8. the initial settlement window starts at the 2026-07-01 floor; the Returns window is 60 days ending asOf", async () => {
  const deps = makeDeps({ accounts: mkAccounts(3, "US") });
  await runReturnsBucketCycle({ bucket: "us", asOf: ASOF, mode: "go-live", deps });
  const ret = deps.calls.fetchExport.find((c) => c.label === "Returns");
  const sett = deps.calls.fetchExport.find((c) => c.label === "Settlements");
  assert.equal(ret.sourceId, RETURNS.id);
  assert.equal(ret.to, ASOF);
  assert.equal(ret.from, addDaysStr(ASOF, -59), "returns window = 60 days ending asOf");
  assert.equal(sett.sourceId, SETTLEMENTS.id);
  assert.equal(sett.from, "2026-07-01", "initial settlement window starts at the floor");
});

test("9. daily settlement window is 21 days once history reaches the daily start", async () => {
  const accounts = mkAccounts(3, "US");
  // history exists but returns coverage is behind asOf, so the batch still fetches; settlementMin is old -> daily.
  const coverage = new Map(accounts.map((a) => [a.accountId, { returnsMax: addDaysStr(ASOF, -1), settlementMax: addDaysStr(ASOF, -1), settlementMin: "2026-07-01" }]));
  const deps = makeDeps({ accounts, coverage });
  await runReturnsBucketCycle({ bucket: "us", asOf: ASOF, mode: "go-live", deps });
  const sett = deps.calls.fetchExport.find((c) => c.label === "Settlements");
  assert.equal(sett.from, addDaysStr(ASOF, -20), "daily settlement window = 21 days ending asOf");
});

test("10. a failed batch preserves LKG for its accounts; other batches proceed", async () => {
  const deps = makeDeps({ accounts: mkAccounts(8, "US"), failBatchIndex: 0 }); // first batch's Returns export throws
  const r = await runReturnsBucketCycle({ bucket: "us", asOf: ASOF, mode: "go-live", deps });
  // batch 0 (5 accts) skipped its writes; batch 1 (3 accts) wrote returns + settlements.
  assert.equal(deps.calls.replaceReturns.length, 3, "only the surviving batch wrote returns");
  assert.ok(r.errors.length >= 1, "the failed batch is recorded");
  assert.equal(r.published, 8, "publish still runs for every account from durable (LKG-safe)");
});

test("11. a same-day fallback is zero-token even when settlements LAG asOf: 'refreshed today' marks the batch covered", async () => {
  const accounts = mkAccounts(8, "US");
  // Settlements lag asOf by a day (settlementMax < asOf) but the batch was written TODAY (refreshed today).
  const coverage = new Map(accounts.map((a) => [a.accountId, { settlementMax: addDaysStr(ASOF, -1), settlementMin: "2026-07-01", settlementRefreshedAt: "2026-09-01T10:00:00Z" }]));
  const deps = makeDeps({ accounts, coverage });
  const r = await runReturnsBucketCycle({ bucket: "us", asOf: ASOF, mode: "go-live", runDate: "2026-09-01", deps });
  assert.equal(r.tokens, 0, "lagging settlements + refreshed-today => zero-token fallback");
  assert.equal(deps.calls.fetchExport.length, 0);
  assert.equal(r.outcome, "COMPLETED_ALREADY_COVERED");
});

test("12. a returns-ONLY account (no durable settlements at all) is still covered by its RETURNS refreshed-today marker", async () => {
  const accounts = mkAccounts(3, "US");
  // No settlement history (settlementMax/RefreshedAt null) but returns were written today -> covered, no re-fetch.
  const coverage = new Map(accounts.map((a) => [a.accountId, { settlementMax: null, settlementRefreshedAt: null, returnsRefreshedAt: "2026-09-01T10:00:00Z" }]));
  const deps = makeDeps({ accounts, coverage });
  const r = await runReturnsBucketCycle({ bucket: "us", asOf: ASOF, mode: "go-live", runDate: "2026-09-01", deps });
  assert.equal(r.tokens, 0, "returns-only refreshed-today => covered");
  assert.equal(deps.calls.fetchExport.length, 0);
});

test("13. a NEW day (runDate advances past the refresh) re-fetches even a recently-refreshed batch", async () => {
  const accounts = mkAccounts(3, "US");
  const coverage = new Map(accounts.map((a) => [a.accountId, { settlementMax: addDaysStr(ASOF, -1), settlementRefreshedAt: "2026-09-01T10:00:00Z" }]));
  const deps = makeDeps({ accounts, coverage });
  // runDate is the day AFTER the last refresh -> the marker no longer applies -> fetch.
  const r = await runReturnsBucketCycle({ bucket: "us", asOf: addDaysStr(ASOF, 1), mode: "go-live", runDate: "2026-09-02", deps });
  assert.ok(r.tokens > 0, "a new run date re-fetches (never permanently covered)");
});

(async () => {
  out("\nReturns & Refund Leakage -- dedicated operator (batching + token + idempotency)");
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { out("FAIL  " + t.name + "\n      " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n      ") : e)); process.exitCode = 1; }
  }
  out("\n" + passed + "/" + tests.length + " assertions passed");
  if (passed !== tests.length) process.exitCode = 1;
})();
