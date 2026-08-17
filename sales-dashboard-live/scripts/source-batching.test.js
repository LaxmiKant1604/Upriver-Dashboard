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
import { assignAccountBatches, batchFamilyKey, batchSellerIds, MAX_ACCOUNTS_PER_BATCH } from "../lib/server/sync/source-batching.js";
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

test("1. 30 compatible accounts => exactly SIX batch request_hashes per source/window", () => {
  const { batches } = assignAccountBatches(mkAccounts(30));
  assert.equal(batches.length, 6, "six batches");
  assert.ok(batches.every((b) => b.accounts.length === 5), "every batch holds exactly five accounts");
  const hashes = batches.map(batchHash);
  assert.equal(new Set(hashes).size, 6, "six DISTINCT canonical request_hashes (one shared export per batch)");
});

test("2. 31 accounts => SEVEN batches, no batch larger than five", () => {
  const { batches } = assignAccountBatches(mkAccounts(31));
  assert.equal(batches.length, 7, "seven batches");
  assert.ok(batches.every((b) => b.accounts.length <= MAX_ACCOUNTS_PER_BATCH), "no batch larger than five");
  assert.deepEqual(batches.map((b) => b.accounts.length), [5, 5, 5, 5, 5, 5, 1], "fill-first: six full batches + one singleton");
  assert.equal(new Set(batches.map(batchHash)).size, 7, "seven distinct batch hashes");
});

test("3. adding account 31 does NOT reshuffle any existing batch (only its batch changes); the six original hashes are unchanged", () => {
  const first30 = mkAccounts(30);
  const a30 = assignAccountBatches(first30);
  const originalHashes = a30.batches.map(batchHash);
  assert.equal(originalHashes.length, 6);

  // Add the 31st account, carrying the EXISTING durable membership forward.
  const all31 = mkAccounts(31);
  const a31 = assignAccountBatches(all31, a30.membership);

  // Every one of the original 30 accounts kept its exact batch index (no reshuffle).
  for (const a of first30) {
    assert.equal(a31.membership.get(a.accountId), a30.membership.get(a.accountId), `account ${a.accountId} did not move`);
  }
  // The new account went into its OWN new batch (index 6); batches 0..5 are byte-identical.
  assert.equal(a31.membership.get("acct-031"), 6, "the 31st account is placed in a fresh batch");
  const newHashes = a31.batches.map(batchHash);
  assert.equal(newHashes.length, 7, "now seven batches");
  assert.deepEqual(newHashes.slice(0, 6), originalHashes, "the six original batch request_hashes are UNCHANGED (no cache invalidation)");
});

test("13. newly discovered/approved accounts automatically enter a compatible batch via the SAME engine", () => {
  // Start with a durable membership for 3 accounts (one non-full batch).
  const seed = assignAccountBatches(mkAccounts(3));
  assert.equal(seed.batches.length, 1);
  assert.equal(seed.batches[0].accounts.length, 3);

  // Four MORE accounts are discovered later; they auto-join via the same engine with the seed membership.
  const grown = assignAccountBatches(mkAccounts(7), seed.membership);
  // The first 3 keep their batch; the batch fills to 5 then a second batch starts -> [5,2], nothing reshuffled.
  for (const a of mkAccounts(3)) assert.equal(grown.membership.get(a.accountId), seed.membership.get(a.accountId), "seed account unchanged");
  assert.deepEqual(grown.batches.map((b) => b.accounts.length), [5, 2], "new accounts fill the non-full batch then open a second, <=5 throughout");
  assert.ok(grown.batches.every((b) => b.accounts.length <= MAX_ACCOUNTS_PER_BATCH));
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
