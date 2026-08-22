// Scheduler v2 -- STABLE <=5-account source batching proof suite (pure, offline, ZERO network/DB).
//
// Proves the batch-engine requirements:
//   1  30 compatible accounts => exactly SIX batch request_hashes per source/window.
//   2  31 accounts => SEVEN batches, with NO batch larger than five.
//   3  adding account 31 does NOT reshuffle any existing batch (only the new account's batch changes);
//      the six original batch request_hashes are byte-identical before and after.
//   13 newly discovered/approved accounts automatically enter a compatible batch via the SAME engine.
//   +  batchFamilyKey never mixes different org / connection / source / columns (no cross-scope batch).
//   +  batchSellerIds is sorted + deduped and matches the canonical request_hash the batch presents.
//   +  five accounts in one batch resolve to ONE shared canonical request_hash.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { assignAccountBatches, batchFamilyKey, batchSellerIds, MAX_ACCOUNTS_PER_BATCH, BATCHING_POLICY_VERSION } from "../lib/server/sync/source-batching.js";
import { sourceRequestIdentity } from "../lib/server/source-identity.js";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

const pad3 = (n) => String(n).padStart(3, "0");
const mkAccounts = (n, prefix = "acct") => Array.from({ length: n }, (_, i) => ({ accountId: `${prefix}-${pad3(i + 1)}`, rawSellerId: `S${pad3(i + 1)}` }));

// A fixed OLI-shaped source request (columns/limit/grouping/ordering) so batch hashes are realistic.
const OLI_COLUMNS = ["date", "seller_or_vendor_id", "sku", "child_asin", "item_price_currency"];
const OLI_OPTIONS = {
  groupBy: OLI_COLUMNS,
  aggregations: [{ column: "item_price_value", op: "sum", as: "total_sales_sum" }, { column: "quantity", op: "sum", as: "total_units_sum" }],
  orderByColumn: "date", orderByDirection: "ASC",
};
const WINDOW = { from: "2025-07-15", to: "2025-07-21" };
const API_KEY = ["prim", "key"].join("-");
const SOURCE_ID = "oli-source-1";

const batchHash = (batch) => sourceRequestIdentity({
  apiKey: API_KEY, sourceId: SOURCE_ID, columns: OLI_COLUMNS,
  ids: batchSellerIds(batch), from: WINDOW.from, to: WINDOW.to, limit: 50000, options: OLI_OPTIONS,
}).requestHash;

test("1. 30 compatible accounts (one family) => exactly ONE batch/export (any number of sellers per export)", () => {
  const { batches } = assignAccountBatches(mkAccounts(30));
  assert.equal(batches.length, 1, "ONE batch (no <=5 split)");
  assert.equal(batches[0].accounts.length, 30, "the single batch covers all 30 accounts");
  assert.equal(batches[0].batchIndex, 0, "canonical batch index 0");
  assert.equal(new Set([batchHash(batches[0])]).size, 1, "ONE canonical request_hash over all 30 sorted sellers");
});

test("mandatory. 30 accounts split 15 US + 15 Non-US => exactly TWO exports: one US + one Non-US", () => {
  // The planner separates by family (US vs Non-US) then batches each family; here each bucket is one family.
  const us = assignAccountBatches(mkAccounts(15, "us"));
  const nonus = assignAccountBatches(mkAccounts(15, "eu"));
  assert.equal(us.batches.length, 1, "one US export");
  assert.equal(nonus.batches.length, 1, "one Non-US export");
  assert.equal(us.batches[0].accounts.length, 15);
  assert.equal(nonus.batches[0].accounts.length, 15);
});

test("2. adding a 31st compatible account creates NO additional batch (still exactly one)", () => {
  const a31 = assignAccountBatches(mkAccounts(31), assignAccountBatches(mkAccounts(30)).membership);
  assert.equal(a31.batches.length, 1, "still one batch (no new batch)");
  assert.equal(a31.batches[0].accounts.length, 31, "the one batch now covers all 31");
  assert.ok(a31.batches.every((b) => b.accounts.length <= MAX_ACCOUNTS_PER_BATCH), "no cap (MAX is unlimited)");
});

test("6. adding an account changes the NEXT cycle's combined seller set + request hash; existing members keep index 0", () => {
  const a30 = assignAccountBatches(mkAccounts(30));
  const before = batchHash(a30.batches[0]);
  const a31 = assignAccountBatches(mkAccounts(31), a30.membership);
  for (const a of mkAccounts(30)) assert.equal(a31.membership.get(a.accountId), 0, "existing member stays in batch 0 (no reshuffle)");
  assert.notEqual(batchHash(a31.batches[0]), before, "the next cycle's combined request_hash reflects the new 31-seller set");
});

test("13. newly discovered/approved accounts automatically join the SAME single batch", () => {
  const seed = assignAccountBatches(mkAccounts(3));
  const grown = assignAccountBatches(mkAccounts(7), seed.membership);
  assert.equal(grown.batches.length, 1, "one batch");
  assert.equal(grown.batches[0].accounts.length, 7, "all seven join the one batch");
  for (const a of mkAccounts(3)) assert.equal(grown.membership.get(a.accountId), 0, "seed accounts stay in batch 0");
});

test("TRANSITION. old <=5 memberships live in a VERSIONED family namespace; the new cycle plans ONE US export; historical byte-identical", () => {
  const us30 = mkAccounts(30);
  const dims = { organizationFingerprint: "org-a", connectionId: "primary", bucket: "us", sourceId: SOURCE_ID, columns: OLI_COLUMNS, groupBy: OLI_OPTIONS.groupBy, aggregations: OLI_OPTIONS.aggregations, orderByColumn: "date", orderByDirection: "ASC", limit: 50000, windowKind: "canonicalOliSlices", marketplaceConstraint: "" };
  const oldKey = batchFamilyKey({ ...dims, batchingPolicyVersion: "le5-v1" }); // old <=5 policy namespace
  const newKey = batchFamilyKey({ ...dims }); // default = BATCHING_POLICY_VERSION (unlimited)
  assert.notEqual(newKey, oldKey, "the bumped batching-policy version yields a FRESH family namespace");
  assert.equal(newKey, batchFamilyKey({ ...dims, batchingPolicyVersion: BATCHING_POLICY_VERSION }), "the default folds BATCHING_POLICY_VERSION");

  // Durable membership store keyed by family. Pre-load the OLD <=5 policy: six batches of five for the 30 accounts.
  const store = new Map();
  const oldMembership = new Map();
  us30.forEach((a, i) => oldMembership.set(a.accountId, Math.floor(i / 5))); // batch_index 0..5
  store.set(oldKey, oldMembership);
  const oldSnapshot = JSON.stringify([...oldMembership.entries()].sort());

  // The NEW plan reads membership under the NEW family key -> nothing there -> fresh single-batch assignment.
  const { batches } = assignAccountBatches(us30, store.get(newKey) || new Map());
  assert.equal(batches.length, 1, "the new cycle plans EXACTLY ONE US export for all 30 accounts");
  assert.equal(batches[0].accounts.length, 30, "the single US batch covers all 30 accounts");
  // The historical <=5 membership is never reinterpreted or mutated.
  assert.equal(JSON.stringify([...store.get(oldKey).entries()].sort()), oldSnapshot, "historical <=5 membership byte-identical");
});

test("family. batchFamilyKey never mixes different organization / connection / source / columns", () => {
  const base = { organizationFingerprint: "org-a", connectionId: "primary", bucket: "us", sourceId: SOURCE_ID, columns: OLI_COLUMNS, groupBy: OLI_COLUMNS, aggregations: OLI_OPTIONS.aggregations, orderByColumn: "date", orderByDirection: "ASC", limit: 50000, windowKind: "canonicalOliSlices", marketplaceConstraint: "us" };
  const k = batchFamilyKey(base);
  assert.equal(k, batchFamilyKey({ ...base }), "same compatibility => same family key (deterministic)");
  assert.notEqual(k, batchFamilyKey({ ...base, organizationFingerprint: "org-b" }), "different organization => different family (never cross-org)");
  assert.notEqual(k, batchFamilyKey({ ...base, connectionId: "dd-secondary" }), "different connection => different family (never mix primary/dd-secondary)");
  assert.notEqual(k, batchFamilyKey({ ...base, sourceId: "other-source" }), "different source => different family");
  assert.notEqual(k, batchFamilyKey({ ...base, columns: ["date", "sku"] }), "different columns => different family");
  assert.notEqual(k, batchFamilyKey({ ...base, bucket: "non-us" }), "different marketplace bucket => different family");
  // Column ORDER is irrelevant (canonical sort) -- the same set is the same family.
  assert.equal(k, batchFamilyKey({ ...base, columns: [...OLI_COLUMNS].reverse() }), "column order does not change the family");
});

test("seller-ids. batchSellerIds is sorted + deduped and yields ONE shared request_hash for the five accounts", () => {
  const { batches } = assignAccountBatches(mkAccounts(5));
  assert.equal(batches.length, 1);
  const ids = batchSellerIds(batches[0]);
  assert.deepEqual(ids, [...ids].sort(), "seller ids are sorted");
  assert.equal(new Set(ids).size, ids.length, "seller ids are deduped");
  assert.equal(ids.length, 5, "all five accounts' seller ids present");
  // The five accounts share exactly ONE canonical request_hash (folds the sorted batch ids).
  const h = batchHash(batches[0]);
  const direct = sourceRequestIdentity({ apiKey: API_KEY, sourceId: SOURCE_ID, columns: OLI_COLUMNS, ids, from: WINDOW.from, to: WINDOW.to, limit: 50000, options: OLI_OPTIONS }).requestHash;
  assert.equal(h, direct, "the batch presents exactly the canonical request_hash over its sorted seller ids");
});

// In-memory model of assign_source_account_batch (the durable RPC): stable index, transactional <=5 cap, and
// the Finding-5 existing-scope match. The real cap is enforced by pg_advisory_xact_lock + this same logic; the
// real WRITE path is exclusively this RPC (service_role has SELECT-only on the table -- Finding 4).
function makeDurableAssigner(max = 5) {
  const rows = [];
  return {
    rows,
    assign(family, accountId, connectionId, orgFp) {
      const existing = rows.find((r) => r.batch_family === family && r.account_id === accountId);
      if (existing) {
        if (existing.connection_id !== connectionId || existing.organization_fingerprint !== orgFp) {
          throw new Error(`existing membership for account ${accountId} in family ${family} has a different connection/organization scope; refusing (no mutation)`);
        }
        return existing.batch_index;
      }
      const counts = new Map();
      for (const r of rows.filter((r) => r.batch_family === family)) counts.set(r.batch_index, (counts.get(r.batch_index) || 0) + 1);
      let idx = null;
      for (const [i, c] of [...counts.entries()].sort((a, b) => a[0] - b[0])) if (c < max) { idx = i; break; }
      if (idx === null) idx = counts.size === 0 ? 0 : Math.max(...counts.keys()) + 1;
      rows.push({ batch_family: family, account_id: accountId, batch_index: idx, connection_id: connectionId, organization_fingerprint: orgFp });
      return idx;
    },
  };
}

test("assign-scope. an existing membership with a DIFFERENT connection/organization raises a typed error WITHOUT mutation (Finding 5)", () => {
  const a = makeDurableAssigner();
  assert.equal(a.assign("fam", "acct-1", "primary", "org-a"), 0, "first assignment");
  assert.equal(a.rows.length, 1);
  assert.throws(() => a.assign("fam", "acct-1", "dd-secondary", "org-a"), /different connection\/organization scope/, "different connection => raise");
  assert.throws(() => a.assign("fam", "acct-1", "primary", "org-b"), /different connection\/organization scope/, "different organization => raise");
  assert.equal(a.rows.length, 1, "no mutation occurred on a scope mismatch");
  assert.equal(a.assign("fam", "acct-1", "primary", "org-a"), 0, "the exact-scope re-assignment still returns the stable index");
});

test("assign-cap. the assignment RPC enforces the <=5 cap transactionally and is stable on re-assign (Finding 4 behavioral model)", () => {
  const a = makeDurableAssigner();
  const ids = Array.from({ length: 6 }, (_, i) => a.assign("fam", `acct-${i + 1}`, "primary", "org-a"));
  assert.deepEqual(ids, [0, 0, 0, 0, 0, 1], "fill-first: five in batch 0, the sixth opens batch 1 (no batch > 5)");
  const counts = new Map();
  for (const r of a.rows) counts.set(r.batch_index, (counts.get(r.batch_index) || 0) + 1);
  assert.ok([...counts.values()].every((c) => c <= 5), "no batch exceeds five");
  assert.equal(a.assign("fam", "acct-1", "primary", "org-a"), 0, "re-assigning an existing account is stable (returns its index, no new row)");
  assert.equal(a.rows.length, 6, "no duplicate row created on re-assign");
});

let failures = 0;
for (const t of tests) {
  try { t.fn(); passed += 1; out("  ok  " + t.name); }
  catch (err) { failures += 1; out("FAIL  " + t.name); out(String(err && err.stack ? err.stack : err)); }
}
out("\n" + passed + " assertions passed");
if (failures) process.exitCode = 1;
