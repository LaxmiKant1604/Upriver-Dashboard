// Phase 1b: prove the per-report source-contract declarations are transcribed
// accurately from the EXECUTABLE builders in api/datadoe.js (not assumed), and that
// they resolve to correct, org-isolated request identities. Static imports only.
//
// Run with: npm run test:report-contracts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { REPORT_SOURCE_CONTRACTS, reportSourceRequestHashes, declaredReportKeys } from "../lib/server/sync/report-source-contracts.js";
import { REPORT_SOURCE_REQUIREMENTS } from "../lib/server/source-contracts.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DD = readFileSync(join(ROOT, "api", "datadoe.js"), "utf8");

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log("  ok  " + name); }
  catch (err) { console.error("FAIL  " + name); console.error(err && err.message ? err.message : err); process.exitCode = 1; throw err; }
}

/* ---- extractors that read the real constants out of api/datadoe.js ---- */
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
  const body = DD.slice(start, close);
  return [...body.matchAll(/\{\s*column:\s*"([^"]+)",\s*aggregation:\s*"([^"]+)",\s*alias:\s*"([^"]+)"\s*\}/g)]
    .map((m) => ({ column: m[1], aggregation: m[2], alias: m[3] }));
}
function constNumber(name) {
  const m = DD.match(new RegExp("const " + name + "\\s*=\\s*(\\d+)\\s*;"));
  if (!m) throw new Error("const " + name + " (number) not found");
  return Number(m[1]);
}

/* -------------------------- executable parity: brand-sales -------------------------- */

test("brand-sales OLI contract matches ORDER_SALES_* constants in api/datadoe.js", () => {
  const oli = REPORT_SOURCE_CONTRACTS["brand-sales"][0];
  assert.equal(oli.sourceKey, "order-line-items");
  assert.deepEqual(oli.columns, constArray("ORDER_SALES_COLUMNS"));
  assert.deepEqual(oli.groupBy, constArray("ORDER_SALES_COLUMNS")); // ORDER_SALES_GROUP_BY = [...ORDER_SALES_COLUMNS]
  assert.deepEqual(oli.aggregations, constAggregations("ORDER_SALES_AGGREGATIONS"));
  assert.equal(oli.limit, constNumber("ORDER_SALES_ROW_LIMIT"));
  assert.equal(oli.orderByColumn, "date");
});

test("brand-sales catalog contract matches PRODUCT_CATALOG_COLUMNS + CATALOG_ROW_LIMIT", () => {
  const cat = REPORT_SOURCE_CONTRACTS["brand-sales"][1];
  assert.equal(cat.sourceKey, "product-catalog");
  assert.deepEqual(cat.columns, constArray("PRODUCT_CATALOG_COLUMNS"));
  assert.equal(cat.limit, constNumber("CATALOG_ROW_LIMIT"));
  assert.equal(cat.orderByColumn, "child_asin");
  assert.equal(cat.groupBy, null);
  assert.equal(cat.aggregations, null);
});

/* ---------------------------- executable parity: sku-pl ---------------------------- */

test("sku-pl contract matches SKU_PL_* constants in api/datadoe.js", () => {
  const c = REPORT_SOURCE_CONTRACTS["sku-pl"][0];
  assert.equal(c.sourceKey, "profit-by-sku-date");
  assert.deepEqual(c.columns, constArray("SKU_PL_GROUP_BY")); // SKU_PL_COLUMNS = [...SKU_PL_GROUP_BY]
  assert.deepEqual(c.groupBy, constArray("SKU_PL_GROUP_BY"));
  assert.deepEqual(c.aggregations, constAggregations("SKU_PL_AGGREGATIONS"));
  assert.equal(c.limit, constNumber("SKU_PL_ROW_LIMIT"));
  assert.equal(c.orderByColumn, "sku");
});

/* ------------------------------ coverage / consistency ------------------------------ */

test("every declared report is a known report and its source keys match the requirements", () => {
  for (const key of declaredReportKeys()) {
    const required = REPORT_SOURCE_REQUIREMENTS[key];
    assert.ok(required, key + " is not in REPORT_SOURCE_REQUIREMENTS");
    const declaredKeys = REPORT_SOURCE_CONTRACTS[key].map((c) => c.sourceKey);
    assert.deepEqual(declaredKeys, required, key + " declared sources must match REPORT_SOURCE_REQUIREMENTS order/set");
  }
});

test("an undeclared report resolves to null (no assumed contract)", () => {
  assert.equal(reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids: ["A"], windows: [{ from: "2025-01-01", to: "2025-12-31" }] }), null);
});

/* ------------------------- resolved request identity behaviour ------------------------- */

const WIN = [{ from: "2024-06-01", to: "2025-08-06" }];

test("brand-sales resolves to two distinct source requests (OLI + catalog)", () => {
  const reqs = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "primary", ids: ["A1", "A2"], windows: WIN });
  assert.equal(reqs.length, 2);
  assert.deepEqual(reqs.map((r) => r.sourceKey), ["order-line-items", "product-catalog"]);
  assert.notEqual(reqs[0].requestHash, reqs[1].requestHash);
  assert.equal(reqs[0].requestMeta.source, "order-line-items");
  assert.equal(reqs[1].requestMeta.source, "product-catalog");
});

test("identical report + scope + window resolves to identical hashes (deterministic dedup)", () => {
  const a = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "primary", ids: ["A1", "A2"], windows: WIN });
  const b = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "primary", ids: ["A2", "A1"], windows: WIN });
  assert.deepEqual(a.map((r) => r.requestHash), b.map((r) => r.requestHash));
});

test("org isolation: primary vs dd-secondary apiKey yields different hashes", () => {
  const p = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "primary-key", ids: ["A1"], windows: WIN });
  const s = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "secondary-key", ids: ["A1"], windows: WIN });
  for (let i = 0; i < p.length; i += 1) assert.notEqual(p[i].requestHash, s[i].requestHash);
});

test("account scope + window changes change the hash", () => {
  const base = reportSourceRequestHashes({ reportKey: "sku-pl", apiKey: "k", ids: ["A1"], windows: WIN })[0].requestHash;
  const otherAccount = reportSourceRequestHashes({ reportKey: "sku-pl", apiKey: "k", ids: ["A2"], windows: WIN })[0].requestHash;
  const otherWindow = reportSourceRequestHashes({ reportKey: "sku-pl", apiKey: "k", ids: ["A1"], windows: [{ from: "2025-01-01", to: "2025-08-06" }] })[0].requestHash;
  assert.notEqual(base, otherAccount);
  assert.notEqual(base, otherWindow);
});

test("sku-pl per-month windows resolve to one distinct request per month", () => {
  const months = [
    { from: "2025-06-01", to: "2025-06-30" },
    { from: "2025-07-01", to: "2025-07-31" },
    { from: "2025-08-01", to: "2025-08-06" },
  ];
  const reqs = reportSourceRequestHashes({ reportKey: "sku-pl", apiKey: "k", ids: ["A1"], windows: months });
  assert.equal(reqs.length, 3);
  assert.equal(new Set(reqs.map((r) => r.requestHash)).size, 3, "each month is a distinct export");
});

console.log("\n" + passed + " assertions passed");
