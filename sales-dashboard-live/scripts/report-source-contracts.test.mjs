// Phase 1b: prove the per-report source-contract declarations are transcribed
// accurately from the EXECUTABLE builders in api/datadoe.js, and that the resolver
// reproduces the live transport's exact 5-ID chunking and applies windows per
// requestKey (no Cartesian product). Static imports only.
//
// Run with: npm run test:report-contracts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  REPORT_SOURCE_CONTRACTS, reportSourceRequestHashes, declaredReportKeys, declaredRequestKeys,
} from "../lib/server/sync/report-source-contracts.js";
import { REPORT_SOURCE_REQUIREMENTS, sourceContractForKey } from "../lib/server/source-contracts.js";
import { sourceRequestIdentity } from "../lib/server/source-identity.js";
import { chunkAccountIds, MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT } from "../lib/server/id-batching.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DD = readFileSync(join(ROOT, "api", "datadoe.js"), "utf8");

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log("  ok  " + name); }
  catch (err) { console.error("FAIL  " + name); console.error(err && err.message ? err.message : err); process.exitCode = 1; throw err; }
}

/* ---- read the real constants out of api/datadoe.js (parity) ---- */
function constArray(name) {
  const start = DD.indexOf("const " + name + " = [");
  if (start < 0) throw new Error("const " + name + " not found in api/datadoe.js");
  const open = DD.indexOf("[", start);
  const close = DD.indexOf("];", open);
  return [...DD.slice(open + 1, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}
function constAggregations(name) {
  const start = DD.indexOf("const " + name + " = [");
  const close = DD.indexOf("];", start);
  return [...DD.slice(start, close).matchAll(/\{\s*column:\s*"([^"]+)",\s*aggregation:\s*"([^"]+)",\s*alias:\s*"([^"]+)"\s*\}/g)]
    .map((m) => ({ column: m[1], aggregation: m[2], alias: m[3] }));
}
function constNumber(name) {
  const m = DD.match(new RegExp("const " + name + "\\s*=\\s*(\\d+)\\s*;"));
  if (!m) throw new Error("const " + name + " (number) not found");
  return Number(m[1]);
}

// Independent "transport oracle": chunk with the same leaf the live transport uses
// and compute the per-chunk identity with the same shared function. This is exactly
// what fetchExportRows -> fetchSourceChunk -> sourceRequestIdentity does.
function transportExpected(reportKey, apiKey, ids, windowsByRequestKey) {
  const contracts = REPORT_SOURCE_CONTRACTS[reportKey];
  const chunks = chunkAccountIds(ids);
  const out = [];
  for (const c of contracts) {
    const contract = sourceContractForKey(c.sourceKey);
    const sourceId = contract ? contract.ids[0] : c.sourceKey;
    const options = { groupBy: c.groupBy || undefined, aggregations: c.aggregations || undefined, orderByColumn: c.orderByColumn, orderByDirection: c.orderByDirection };
    for (const w of windowsByRequestKey[c.requestKey]) {
      const from = w.from == null ? null : w.from;
      const to = w.to == null ? null : w.to;
      for (const chunk of chunks) {
        out.push({
          requestKey: c.requestKey,
          sellerOrVendorIds: chunk,
          from, to,
          requestHash: sourceRequestIdentity({ apiKey, sourceId, columns: c.columns, ids: chunk, from, to, limit: c.limit, options }).requestHash,
        });
      }
    }
  }
  return out;
}

const ids = (n) => Array.from({ length: n }, (_, i) => "id" + i);
const SHARED = { from: "2024-06-01", to: "2025-08-06" };
const bsWin = { "brand-sales:order-lines": [SHARED], "brand-sales:catalog": [SHARED] };

/* ------------------------------ executable parity ------------------------------ */

test("brand-sales OLI contract matches ORDER_SALES_* constants + has stable requestKey", () => {
  const oli = REPORT_SOURCE_CONTRACTS["brand-sales"][0];
  assert.equal(oli.requestKey, "brand-sales:order-lines");
  assert.equal(oli.sourceKey, "order-line-items");
  assert.deepEqual(oli.columns, constArray("ORDER_SALES_COLUMNS"));
  assert.deepEqual(oli.groupBy, constArray("ORDER_SALES_COLUMNS")); // GROUP_BY = [...COLUMNS]
  assert.deepEqual(oli.aggregations, constAggregations("ORDER_SALES_AGGREGATIONS"));
  assert.equal(oli.limit, constNumber("ORDER_SALES_ROW_LIMIT"));
});

test("brand-sales catalog contract matches PRODUCT_CATALOG_COLUMNS + CATALOG_ROW_LIMIT", () => {
  const cat = REPORT_SOURCE_CONTRACTS["brand-sales"][1];
  assert.equal(cat.requestKey, "brand-sales:catalog");
  assert.deepEqual(cat.columns, constArray("PRODUCT_CATALOG_COLUMNS"));
  assert.equal(cat.limit, constNumber("CATALOG_ROW_LIMIT"));
  assert.equal(cat.groupBy, null);
  assert.equal(cat.aggregations, null);
});

test("sku-pl contract matches SKU_PL_* constants + has stable requestKey", () => {
  const c = REPORT_SOURCE_CONTRACTS["sku-pl"][0];
  assert.equal(c.requestKey, "sku-pl:monthly-profit");
  assert.deepEqual(c.columns, constArray("SKU_PL_GROUP_BY")); // COLUMNS = [...GROUP_BY]
  assert.deepEqual(c.aggregations, constAggregations("SKU_PL_AGGREGATIONS"));
  assert.equal(c.limit, constNumber("SKU_PL_ROW_LIMIT"));
});

/* --------------------------------- coverage --------------------------------- */

test("declared reports are known and their source keys match the requirements", () => {
  for (const key of declaredReportKeys()) {
    assert.deepEqual(REPORT_SOURCE_CONTRACTS[key].map((c) => c.sourceKey), REPORT_SOURCE_REQUIREMENTS[key]);
  }
  assert.deepEqual(declaredRequestKeys("brand-sales"), ["brand-sales:order-lines", "brand-sales:catalog"]);
  assert.equal(declaredRequestKeys("fba-plan"), null);
});

test("an undeclared report resolves to null", () => {
  assert.equal(reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids: ids(3), windowsByRequestKey: {} }), null);
});

/* ----------------- exact 5-ID chunking vs the live transport ----------------- */

test("MAX chunk size is 5, matching the live transport", () => {
  assert.equal(MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT, 5);
});

for (const n of [0, 1, 5, 6, 11]) {
  test(`resolver reproduces the transport chunks + hashes for ${n} IDs`, () => {
    const got = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "primary", ids: ids(n), windowsByRequestKey: bsWin });
    const exp = transportExpected("brand-sales", "primary", ids(n), bsWin);
    assert.equal(got.length, exp.length);
    for (let i = 0; i < exp.length; i += 1) {
      assert.deepEqual(got[i].sellerOrVendorIds, exp[i].sellerOrVendorIds);
      assert.equal(got[i].requestHash, exp[i].requestHash);
      assert.equal(got[i].requestKey, exp[i].requestKey);
    }
  });
}

test("empty ID scope creates no source request", () => {
  assert.deepEqual(reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: [], windowsByRequestKey: bsWin }), []);
});

test("six IDs create two chunks per source, not one (2 sources x 1 window x 2 chunks = 4)", () => {
  const got = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: ids(6), windowsByRequestKey: bsWin });
  assert.equal(got.length, 4);
  const oli = got.filter((r) => r.requestKey === "brand-sales:order-lines");
  assert.deepEqual(oli.map((r) => r.sellerOrVendorIds), [["id0", "id1", "id2", "id3", "id4"], ["id5"]]);
});

test("eleven IDs create three chunks per source (2 x 1 x 3 = 6)", () => {
  const got = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: ids(11), windowsByRequestKey: bsWin });
  assert.equal(got.length, 6);
  const oli = got.filter((r) => r.requestKey === "brand-sales:order-lines");
  assert.deepEqual(oli.map((r) => r.sellerOrVendorIds), [["id0", "id1", "id2", "id3", "id4"], ["id5", "id6", "id7", "id8", "id9"], ["id10"]]);
});

test("each result carries its exact ID chunk and the fields the worker needs", () => {
  const [first] = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: ids(6), windowsByRequestKey: bsWin });
  for (const f of ["requestKey", "sourceKey", "sourceId", "sellerOrVendorIds", "from", "to", "limit", "options", "requestHash", "organizationFingerprint", "accountScopeHash", "requestMeta"]) {
    assert.ok(f in first, "missing field " + f);
  }
  assert.deepEqual(first.sellerOrVendorIds, ["id0", "id1", "id2", "id3", "id4"]);
});

test("chunk boundaries follow input order; reordering across a boundary changes membership", () => {
  const a = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: ["a", "b", "c", "d", "e", "f"], windowsByRequestKey: bsWin })
    .filter((r) => r.requestKey === "brand-sales:order-lines").map((r) => r.sellerOrVendorIds);
  const b = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: ["f", "a", "b", "c", "d", "e"], windowsByRequestKey: bsWin })
    .filter((r) => r.requestKey === "brand-sales:order-lines").map((r) => r.sellerOrVendorIds);
  assert.deepEqual(a, [["a", "b", "c", "d", "e"], ["f"]]);
  assert.deepEqual(b, [["f", "a", "b", "c", "d"], ["e"]]);
});

test("reordering IDs WITHIN one chunk does not change the request hash (identity sorts)", () => {
  const h1 = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: ["a", "b", "c"], windowsByRequestKey: bsWin })[0].requestHash;
  const h2 = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: ["c", "b", "a"], windowsByRequestKey: bsWin })[0].requestHash;
  assert.equal(h1, h2);
});

/* ------------------- per-requestKey windows (no Cartesian) ------------------- */

test("sku-pl monthly windows resolve to one request per month (no cross-product)", () => {
  const months = [
    { from: "2025-06-01", to: "2025-06-30" },
    { from: "2025-07-01", to: "2025-07-31" },
    { from: "2025-08-01", to: "2025-08-06" },
  ];
  const got = reportSourceRequestHashes({ reportKey: "sku-pl", apiKey: "k", ids: ["A1", "A2"], windowsByRequestKey: { "sku-pl:monthly-profit": months } });
  assert.equal(got.length, 3); // 1 source x 3 windows x 1 chunk (2 ids <= 5)
  assert.equal(new Set(got.map((r) => r.requestHash)).size, 3);
  assert.deepEqual(got.map((r) => ({ from: r.from, to: r.to })), months);
});

test("different request keys receive ONLY their own windows", () => {
  const W1 = { from: "2024-01-01", to: "2025-01-01" };
  const W2 = { from: "2020-01-01", to: "2020-12-31" };
  const got = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: ["A1"], windowsByRequestKey: { "brand-sales:order-lines": [W1], "brand-sales:catalog": [W2] } });
  const oli = got.filter((r) => r.requestKey === "brand-sales:order-lines");
  const cat = got.filter((r) => r.requestKey === "brand-sales:catalog");
  assert.ok(oli.every((r) => r.from === W1.from && r.to === W1.to));
  assert.ok(cat.every((r) => r.from === W2.from && r.to === W2.to));
});

test("a no-date request never receives another source's dates", () => {
  const got = reportSourceRequestHashes({
    reportKey: "brand-sales", apiKey: "k", ids: ["A1"],
    windowsByRequestKey: { "brand-sales:order-lines": [{ from: "2024-01-01", to: "2025-01-01" }], "brand-sales:catalog": [{ from: null, to: null }] },
  });
  const cat = got.find((r) => r.requestKey === "brand-sales:catalog");
  assert.equal(cat.from, null);
  assert.equal(cat.to, null);
  assert.equal(cat.requestMeta.from, null);
  assert.equal(cat.requestMeta.to, null);
});

/* --------------------------------- validation --------------------------------- */

test("missing windows for a declared request key throws", () => {
  assert.throws(() => reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: ["A1"], windowsByRequestKey: { "brand-sales:order-lines": [SHARED] } }), /Missing windows/);
});

test("an unknown request key throws", () => {
  assert.throws(() => reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: ["A1"], windowsByRequestKey: { ...bsWin, "brand-sales:bogus": [SHARED] } }), /Unknown request key/);
});

/* ------------------------------- org isolation ------------------------------- */

test("primary and dd-secondary organizations remain isolated (different hashes)", () => {
  const p = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "primary-key", ids: ids(6), windowsByRequestKey: bsWin });
  const s = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "secondary-key", ids: ids(6), windowsByRequestKey: bsWin });
  for (let i = 0; i < p.length; i += 1) {
    assert.notEqual(p[i].requestHash, s[i].requestHash);
    assert.notEqual(p[i].organizationFingerprint, s[i].organizationFingerprint);
  }
});

console.log("\n" + passed + " assertions passed");
