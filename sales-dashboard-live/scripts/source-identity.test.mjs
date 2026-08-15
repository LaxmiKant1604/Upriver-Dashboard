// Byte-identity + complete-request-identity tests for the extracted
// lib/server/source-identity.js. No network, static imports only.
//
// The oracle below is an INDEPENDENT verbatim reconstruction of the algorithm as
// it existed inline in lib/server/datadoe.js BEFORE extraction. If the extracted
// module diverges in any way (separator, sort, field, default), the parity
// assertions fail — this is what guarantees existing source_export_cache entries
// keyed by request_hash remain valid.
//
// Run with: npm run test:source-identity

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sourceContractForId } from "../lib/server/source-contracts.js";
import { sourceRequestIdentity } from "../lib/server/source-identity.js";

/* --------- oracle: the original in-file algorithm, reconstructed verbatim ------- */
function oSha(value) { return createHash("sha256").update(String(value)).digest("hex"); }
function oStable(value) {
  if (Array.isArray(value)) return value.map(oStable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, oStable(value[k])]));
}
function oIdentity({ apiKey, sourceId, columns, ids, from, to, limit, options }) {
  const contract = sourceContractForId(sourceId);
  const organizationFingerprint = oSha(apiKey).slice(0, 24);
  const accountScopeHash = oSha([...ids].map(String).sort().join("\u001f"));
  const requestMeta = oStable({
    source: contract?.key || String(sourceId),
    columns: [...columns].map(String).sort(),
    from: from || null,
    to: to || null,
    limit,
    groupBy: [...(options.groupBy || [])].map(String).sort(),
    aggregations: [...(options.aggregations || [])].map(oStable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    orderByColumn: options.orderByColumn || "date",
    orderByDirection: options.orderByDirection || "ASC",
  });
  const requestHash = oSha(JSON.stringify({ organizationFingerprint, accountScopeHash, requestMeta }));
  return { requestHash, organizationFingerprint, accountScopeHash, requestMeta };
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log("  ok  " + name); }
  catch (err) { console.error("FAIL  " + name); console.error(err && err.message ? err.message : err); process.exitCode = 1; throw err; }
}

const ORDER_LINE_ITEMS = "89b27535d27c2a94db5ae39af4717f542624ff4df7802fd633e16c78674a1778";
const PRODUCT_CATALOG = "68d2de238e8d1a47bc56a981a99d54558507b0bafb1e09f1b3e95fb7750a17a8";

// A battery of varied requests: real + unknown source, differing column/id order,
// windows, limits, groupBy, aggregations, ordering, and an empty options object.
const CASES = [
  { apiKey: "primary-key", sourceId: ORDER_LINE_ITEMS, columns: ["date", "amazon_order_id", "sku"], ids: ["A1", "A2"], from: "2025-01-01", to: "2025-12-31", limit: 100000, options: {} },
  { apiKey: "primary-key", sourceId: ORDER_LINE_ITEMS, columns: ["sku", "amazon_order_id", "date"], ids: ["A2", "A1"], from: "2025-01-01", to: "2025-12-31", limit: 100000, options: {} }, // reordered cols/ids -> same hash
  { apiKey: "secondary-key", sourceId: ORDER_LINE_ITEMS, columns: ["date", "sku"], ids: ["A1", "A2"], from: "2025-01-01", to: "2025-12-31", limit: 100000, options: {} },
  { apiKey: "primary-key", sourceId: PRODUCT_CATALOG, columns: ["child_asin", "product_brand"], ids: ["A1"], from: null, to: null, limit: 5000, options: { orderByColumn: "child_asin", orderByDirection: "DESC" } },
  { apiKey: "primary-key", sourceId: "401ffcd7e5", columns: ["date", "total_units"], ids: ["A1"], from: "2025-06-01", to: "2025-06-30", limit: 200, options: { groupBy: ["date", "child_asin"], aggregations: [{ column: "total_units", op: "sum" }] } },
  { apiKey: "primary-key", sourceId: "unknown-source-id", columns: ["x"], ids: ["Z"], from: undefined, to: undefined, limit: 1, options: { aggregations: [{ b: 2 }, { a: 1 }] } },
];

test("extracted sourceRequestIdentity is byte-identical to the pre-extraction oracle", () => {
  for (const c of CASES) {
    assert.deepEqual(sourceRequestIdentity(c), oIdentity(c), "identity mismatch for " + JSON.stringify(c.sourceId));
  }
});

test("column and account-id ORDER does not change the hash (sorted canonically)", () => {
  assert.equal(sourceRequestIdentity(CASES[0]).requestHash, sourceRequestIdentity(CASES[1]).requestHash);
});

test("resolved source key is the contract key, not the raw id (source cache stays valid)", () => {
  const id = sourceRequestIdentity(CASES[0]);
  assert.equal(id.requestMeta.source, "order-line-items");
  assert.equal(sourceRequestIdentity(CASES[5]).requestMeta.source, "unknown-source-id"); // falls back to raw id
});

test("org isolation: a different apiKey yields a different fingerprint and hash", () => {
  const primary = sourceRequestIdentity(CASES[0]);
  const secondary = sourceRequestIdentity({ ...CASES[0], apiKey: "secondary-key" });
  assert.notEqual(primary.organizationFingerprint, secondary.organizationFingerprint);
  assert.notEqual(primary.requestHash, secondary.requestHash);
});

test("account scope isolation: different account ids yield a different hash", () => {
  const a = sourceRequestIdentity(CASES[0]);
  const b = sourceRequestIdentity({ ...CASES[0], ids: ["A1", "A3"] });
  assert.notEqual(a.accountScopeHash, b.accountScopeHash);
  assert.notEqual(a.requestHash, b.requestHash);
});

test("window / columns / limit / ordering each change the hash", () => {
  const base = sourceRequestIdentity(CASES[0]).requestHash;
  assert.notEqual(base, sourceRequestIdentity({ ...CASES[0], to: "2025-11-30" }).requestHash, "window");
  assert.notEqual(base, sourceRequestIdentity({ ...CASES[0], columns: ["date"] }).requestHash, "columns");
  assert.notEqual(base, sourceRequestIdentity({ ...CASES[0], limit: 50000 }).requestHash, "limit");
  assert.notEqual(base, sourceRequestIdentity({ ...CASES[0], options: { orderByDirection: "DESC" } }).requestHash, "ordering");
});

test("golden request_hash is a pinned literal (guards drift of BOTH module and oracle)", () => {
  // Hardcoded so a change to either the extracted module or the oracle is caught.
  // Equals the oracle for CASES[0] (asserted above), i.e. the pre-extraction hash.
  const GOLDEN = "5601253219be13c7a7431e10f58cfb05d26d963ef89a9a4cd678a994e04aac1e";
  assert.equal(sourceRequestIdentity(CASES[0]).requestHash, GOLDEN);
  assert.equal(oIdentity(CASES[0]).requestHash, GOLDEN);
});

console.log("\n" + passed + " assertions passed");
