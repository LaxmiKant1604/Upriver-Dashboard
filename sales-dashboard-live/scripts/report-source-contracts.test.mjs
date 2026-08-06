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
  REPORT_DERIVED_SOURCE_KEYS,
  REPORT_DERIVATION,
  REPORT_SOURCE_CONTRACTS,
  reportSourceRequestHashes,
  declaredReportKeys,
  declaredRequestKeys,
  reportSourceCoverage,
  rejectsAtCap,
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

test("owned plus explicitly derived source keys exactly cover each report's requirements", () => {
  for (const key of declaredReportKeys()) {
    const required = REPORT_SOURCE_REQUIREMENTS[key];
    assert.ok(required, key + " missing from REPORT_SOURCE_REQUIREMENTS");
    const owned = REPORT_SOURCE_CONTRACTS[key].map((c) => c.sourceKey);
    const represented = [...new Set([...owned, ...(REPORT_DERIVED_SOURCE_KEYS[key] || [])])];
    assert.deepEqual(represented, required, key + " must represent every required source exactly");
    assert.ok(reportSourceCoverage(key), key + " must declare its coverage status");
  }
  assert.deepEqual(declaredRequestKeys("brand-sales"), ["brand-sales:order-lines", "brand-sales:catalog"]);
  assert.equal(declaredRequestKeys("listing-health"), null); // insight report intentionally not declared yet
  assert.equal(reportSourceCoverage("daily-reporting"), "complete");
  assert.equal(reportSourceCoverage("fba-plan"), "complete");
  assert.equal(reportSourceCoverage("keyword-rank"), "complete");
  assert.equal(reportSourceCoverage("content-changes"), "complete");
});

test("request keys are unique within a report and prefixed by the report key", () => {
  for (const key of declaredReportKeys()) {
    const keys = REPORT_SOURCE_CONTRACTS[key].map((c) => c.requestKey);
    assert.equal(new Set(keys).size, keys.length, key + " has duplicate request keys");
    for (const rk of keys) assert.ok(rk.startsWith(key + ":"), rk + " must start with '" + key + ":'");
  }
});

test("an undeclared (insight) report resolves to null", () => {
  assert.equal(reportSourceRequestHashes({ reportKey: "listing-health", apiKey: "k", ids: ids(3), windowsByRequestKey: {} }), null);
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

test("empty ID scope returns [] BEFORE window validation (missing/empty window map is fine)", () => {
  assert.deepEqual(reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: [], windowsByRequestKey: bsWin }), []);
  assert.deepEqual(reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: [], windowsByRequestKey: {} }), []);
  assert.deepEqual(reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: [] }), []); // no window map at all
  assert.deepEqual(reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: null, windowsByRequestKey: {} }), []);
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

/* ===================== next operational batch: recon / daily / fba ===================== */

const recon = REPORT_SOURCE_CONTRACTS.reconciliation;
const daily = REPORT_SOURCE_CONTRACTS["daily-reporting"];
const fba = REPORT_SOURCE_CONTRACTS["fba-plan"];
const byKey = (list, rk) => list.find((c) => c.requestKey === rk);

// window fixtures
const reconMonths = ["2025-03", "2025-04", "2025-05", "2025-06", "2025-07", "2025-08"]
  .map((m) => ({ from: m + "-01", to: m + "-28" }));
const reconRange = [{ from: "2025-03-01", to: "2025-08-28" }];
const reconWin = { "reconciliation:order-lines": reconMonths, "reconciliation:settlements": reconMonths, "reconciliation:catalog": reconRange };

const fbaMonths = [{ from: "2025-05-01", to: "2025-05-31" }, { from: "2025-06-01", to: "2025-06-30" }, { from: "2025-07-01", to: "2025-07-31" }, { from: "2025-08-01", to: "2025-08-06" }];
const fbaBase = {
  "fba-plan:monthly-units": fbaMonths,
  "fba-plan:current-daily-dates": [{ from: "2025-08-01", to: "2025-08-06" }],
  "fba-plan:catalog": [{ from: "2025-05-01", to: "2025-08-06" }],
  "fba-plan:inventory-health": [{ from: "2025-07-27", to: "2025-08-06" }],
};
const fbaWithAwd = { ...fbaBase, "fba-plan:awd": [{ from: null, to: null }] };

/* --- executable parity: reconciliation --- */
test("reconciliation order-lines contract matches RECONCILIATION_ORDER_* constants", () => {
  const c = byKey(recon, "reconciliation:order-lines");
  assert.deepEqual(c.columns, constArray("RECONCILIATION_ORDER_COLUMNS"));
  assert.deepEqual(c.groupBy, constArray("RECONCILIATION_ORDER_COLUMNS")); // GROUP_BY = [...COLUMNS]
  assert.deepEqual(c.aggregations, constAggregations("RECONCILIATION_ORDER_AGGREGATIONS"));
  assert.equal(c.limit, constNumber("RECONCILIATION_ROW_LIMIT"));
  assert.equal(c.orderByColumn, "date");
  assert.equal(c.orderByDirection, "ASC");
});
test("reconciliation settlements contract matches RECONCILIATION_SETTLEMENT_* constants", () => {
  const c = byKey(recon, "reconciliation:settlements");
  assert.deepEqual(c.columns, constArray("RECONCILIATION_SETTLEMENT_COLUMNS"));
  assert.deepEqual(c.groupBy, constArray("RECONCILIATION_SETTLEMENT_COLUMNS"));
  assert.deepEqual(c.aggregations, constAggregations("RECONCILIATION_SETTLEMENT_AGGREGATIONS"));
  assert.equal(c.limit, constNumber("RECONCILIATION_ROW_LIMIT"));
});
test("reconciliation catalog uses PRODUCT_CATALOG_COLUMNS + CATALOG_ROW_LIMIT, no groupBy/agg", () => {
  const c = byKey(recon, "reconciliation:catalog");
  assert.deepEqual(c.columns, constArray("PRODUCT_CATALOG_COLUMNS"));
  assert.equal(c.limit, constNumber("CATALOG_ROW_LIMIT"));
  assert.equal(c.groupBy, null);
  assert.equal(c.aggregations, null);
  assert.equal(c.orderByColumn, "child_asin");
});

/* --- executable parity: daily-reporting (ASIN/day superset + catalog) --- */
test("daily-reporting ASIN/day superset matches DAILY_BRAND_SALES_* constants (monthly-segmented)", () => {
  const c = byKey(daily, "daily-reporting:asin-day-superset");
  assert.deepEqual(c.columns, constArray("DAILY_BRAND_SALES_COLUMNS"));
  assert.deepEqual(c.groupBy, constArray("DAILY_BRAND_SALES_GROUP_BY"));
  assert.deepEqual(c.aggregations, constAggregations("DAILY_SALES_AGGREGATIONS"));
  assert.equal(c.limit, constNumber("DAILY_BRAND_ROW_LIMIT")); // strict per-month cap
  assert.ok(c.windowKind.startsWith("per-month"), "superset must be monthly-segmented");
});
test("daily-reporting catalog matches PRODUCT_CATALOG_COLUMNS + CATALOG_ROW_LIMIT; no compact all-brand export", () => {
  const c = byKey(daily, "daily-reporting:catalog");
  assert.deepEqual(c.columns, constArray("PRODUCT_CATALOG_COLUMNS"));
  assert.equal(c.limit, constNumber("CATALOG_ROW_LIMIT"));
  assert.equal(c.groupBy, null);
  // No per-brand and no compact all-brand export: exactly two owned exports.
  assert.equal(daily.length, 2);
  assert.deepEqual(daily.map((x) => x.requestKey), ["daily-reporting:asin-day-superset", "daily-reporting:catalog"]);
  // Ads remain a derived dependency, not an owned export.
  assert.ok((REPORT_DERIVED_SOURCE_KEYS["daily-reporting"] || []).includes("ads-campaign-date"));
});
test("daily-reporting derivation strategy derives all-brand + named-brand from the superset (no per-brand export)", () => {
  const d = REPORT_DERIVATION["daily-reporting"];
  assert.ok(d && Array.isArray(d.derivedFrom));
  assert.deepEqual(d.derivedFrom, ["daily-reporting:asin-day-superset", "daily-reporting:catalog"]);
  assert.ok(d.outputs.includes("all-brand"));
  assert.ok(/no per-brand export/i.test(d.strategy));
  // Structural token-saving proof: the ASIN/day builder is monthly-segmented in code,
  // so a named-brand report never triggers its own per-brand DataDoe export.
  assert.ok(DD.includes("async function fetchDailyBrandSalesRows"));
  assert.ok(/for \(const window of splitDateRangeByMonth\(from, to\)\)/.test(DD.slice(DD.indexOf("fetchDailyBrandSalesRows"))), "named-brand fetch must be monthly-segmented");
});

/* --- executable parity: fba-plan --- */
test("fba-plan monthly-units matches the inline child_asin units export (planAsinUnits)", () => {
  const c = byKey(fba, "fba-plan:monthly-units");
  assert.deepEqual(c.columns, ["child_asin"]);
  assert.deepEqual(c.groupBy, ["child_asin"]);
  assert.deepEqual(c.aggregations, [{ column: "total_units", aggregation: "sum", alias: "units_sum" }]);
  assert.equal(c.limit, constNumber("PLAN_SALES_ROW_LIMIT"));
  assert.equal(c.orderByColumn, "child_asin");
  assert.ok(DD.includes('PLAN_SALES_SOURCE_ID, ["child_asin"]'), "planAsinUnits child_asin export must exist");
});
test("fba-plan current-daily-dates matches the inline date units export (limit 500)", () => {
  const c = byKey(fba, "fba-plan:current-daily-dates");
  assert.deepEqual(c.columns, ["date"]);
  assert.deepEqual(c.groupBy, ["date"]);
  assert.deepEqual(c.aggregations, [{ column: "total_units", aggregation: "sum", alias: "units_sum" }]);
  assert.equal(c.limit, 500);
  assert.equal(c.orderByColumn, "date");
  assert.ok(DD.includes('PLAN_SALES_SOURCE_ID, ["date"]'), "current-daily date export must exist");
  assert.ok(DD.includes("current.from, current.to, 500,"), "date export limit 500 must exist");
});
test("fba-plan catalog / inventory-health / awd match their constants", () => {
  const cat = byKey(fba, "fba-plan:catalog");
  assert.deepEqual(cat.columns, constArray("PRODUCT_CATALOG_COLUMNS"));
  assert.equal(cat.limit, constNumber("CATALOG_ROW_LIMIT"));
  const inv = byKey(fba, "fba-plan:inventory-health");
  assert.deepEqual(inv.columns, constArray("FBA_HEALTH_COLUMNS"));
  assert.equal(inv.limit, constNumber("PLAN_INVENTORY_ROW_LIMIT"));
  assert.equal(inv.orderByColumn, "date");
  assert.equal(inv.orderByDirection, "DESC");
  const awd = byKey(fba, "fba-plan:awd");
  assert.deepEqual(awd.columns, constArray("LISTINGS_AWD_COLUMNS"));
  assert.equal(awd.limit, constNumber("CATALOG_ROW_LIMIT"));
  assert.deepEqual(awd.marketplaceCountries, ["US"]);
  assert.equal(awd.orderByColumn, "child_asin");
});

/* --- monthly segmentation, no cross-product --- */
test("reconciliation segments orders + settlements per month; catalog stays a single range", () => {
  const got = reportSourceRequestHashes({ reportKey: "reconciliation", apiKey: "k", ids: ["A1"], windowsByRequestKey: reconWin });
  assert.equal(got.filter((r) => r.requestKey === "reconciliation:order-lines").length, 6);
  assert.equal(got.filter((r) => r.requestKey === "reconciliation:settlements").length, 6);
  assert.equal(got.filter((r) => r.requestKey === "reconciliation:catalog").length, 1);
  assert.equal(got.length, 13); // 6 + 6 + 1, single chunk (no cross-product)
  assert.equal(new Set(got.filter((r) => r.requestKey === "reconciliation:order-lines").map((r) => r.requestHash)).size, 6);
});
test("fba-plan monthly-units has one request per month; total is additive, not multiplied", () => {
  const got = reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids: ["A1"], windowsByRequestKey: fbaWithAwd, marketplaceCountry: "US" });
  assert.equal(got.filter((r) => r.requestKey === "fba-plan:monthly-units").length, 4);
  assert.equal(got.filter((r) => r.requestKey === "fba-plan:current-daily-dates").length, 1);
  assert.equal(got.filter((r) => r.requestKey === "fba-plan:catalog").length, 1);
  assert.equal(got.filter((r) => r.requestKey === "fba-plan:inventory-health").length, 1);
  assert.equal(got.filter((r) => r.requestKey === "fba-plan:awd").length, 1);
  assert.equal(got.length, 8); // 4+1+1+1+1
});

/* --- same source id, different identity, never shared --- */
test("fba-plan's two Sales & Traffic exports have distinct identities even at the same window", () => {
  const got = reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids: ["A1"], windowsByRequestKey: fbaWithAwd, marketplaceCountry: "US" });
  const mu = got.find((r) => r.requestKey === "fba-plan:monthly-units" && r.from === "2025-08-01");
  const dd = got.find((r) => r.requestKey === "fba-plan:current-daily-dates");
  assert.equal(mu.sourceId, dd.sourceId); // same Sales & Traffic source id
  assert.equal(mu.from, dd.from);
  assert.equal(mu.to, dd.to); // same window
  assert.notEqual(mu.requestHash, dd.requestHash); // different columns => not a shared export
});

/* --- country-driven US-only AWD --- */
test("fba-plan resolves without AWD for a non-US account", () => {
  const got = reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids: ["A1"], windowsByRequestKey: fbaBase, marketplaceCountry: "IN" });
  assert.ok(got.length === 7);
  assert.ok(got.every((r) => r.requestKey !== "fba-plan:awd"));
});
test("fba-plan resolves AWD as a no-date request for a US account", () => {
  const got = reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids: ["A1"], windowsByRequestKey: fbaWithAwd, marketplaceCountry: "US" });
  const awd = got.filter((r) => r.requestKey === "fba-plan:awd");
  assert.equal(awd.length, 1);
  assert.equal(awd[0].from, null);
  assert.equal(awd[0].to, null);
  assert.equal(awd[0].requestMeta.from, null);
});
test("fba-plan requires marketplace metadata for its conditional AWD contract", () => {
  assert.throws(
    () => reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids: ["A1"], windowsByRequestKey: fbaBase }),
    /Marketplace country is required/,
  );
});
test("US fba-plan cannot silently omit its AWD request", () => {
  assert.throws(
    () => reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids: ["A1"], windowsByRequestKey: fbaBase, marketplaceCountry: "US" }),
    /Missing windows.*fba-plan:awd/,
  );
});
test("non-US fba-plan rejects an accidental AWD request", () => {
  assert.throws(
    () => reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids: ["A1"], windowsByRequestKey: fbaWithAwd, marketplaceCountry: "IN" }),
    /does not apply.*IN/,
  );
});
test("empty fba-plan scope returns before country and window validation", () => {
  assert.deepEqual(reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids: [] }), []);
});

/* --- 0/1/5/6/11-ID chunking for the new batch (reconciliation) --- */
for (const n of [0, 1, 5, 6, 11]) {
  test(`reconciliation reproduces the transport chunks + hashes for ${n} IDs`, () => {
    const got = reportSourceRequestHashes({ reportKey: "reconciliation", apiKey: "primary", ids: ids(n), windowsByRequestKey: reconWin });
    const exp = transportExpected("reconciliation", "primary", ids(n), reconWin);
    assert.equal(got.length, exp.length);
    for (let i = 0; i < exp.length; i += 1) {
      assert.deepEqual(got[i].sellerOrVendorIds, exp[i].sellerOrVendorIds);
      assert.equal(got[i].requestHash, exp[i].requestHash);
    }
  });
}

test("validation still applies to the new reports (missing required key throws)", () => {
  assert.throws(() => reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids: ["A1"], windowsByRequestKey: { "fba-plan:monthly-units": fbaMonths }, marketplaceCountry: "IN" }), /Missing windows/);
});

/* ===================== keyword-rank + content-changes ===================== */

const keyword = REPORT_SOURCE_CONTRACTS["keyword-rank"];
const content = REPORT_SOURCE_CONTRACTS["content-changes"];
const kwWin = {
  "keyword-rank:sqp-weekly": [{ from: "2025-05-14", to: "2025-08-06" }],
  "keyword-rank:sqp-monthly": [{ from: "2024-08-06", to: "2025-08-06" }],
  "keyword-rank:catalog": [{ from: "2024-08-06", to: "2025-08-06" }],
};
const ccWin = {
  "content-changes:events": [{ from: null, to: null }],
  "content-changes:catalog": [{ from: "2024-08-06", to: "2025-08-06" }],
};

test("keyword-rank weekly + monthly SQP contracts match SQP_COLUMNS + SQP_ROW_LIMIT (raw rows)", () => {
  for (const rk of ["keyword-rank:sqp-weekly", "keyword-rank:sqp-monthly"]) {
    const c = byKey(keyword, rk);
    assert.deepEqual(c.columns, constArray("SQP_COLUMNS"));
    assert.equal(c.limit, constNumber("SQP_ROW_LIMIT"));
    assert.equal(c.groupBy, null);
    assert.equal(c.aggregations, null);
    assert.equal(c.orderByColumn, "date");
    assert.ok(/HTTP 424/.test(c.orgAvailability), rk + " must document the org-availability terminal status");
  }
  assert.equal(byKey(keyword, "keyword-rank:sqp-weekly").sourceKey, "sqp-weekly");
  assert.equal(byKey(keyword, "keyword-rank:sqp-monthly").sourceKey, "sqp-monthly");
});
test("keyword-rank catalog matches PRODUCT_CATALOG_COLUMNS + CATALOG_ROW_LIMIT", () => {
  const c = byKey(keyword, "keyword-rank:catalog");
  assert.deepEqual(c.columns, constArray("PRODUCT_CATALOG_COLUMNS"));
  assert.equal(c.limit, constNumber("CATALOG_ROW_LIMIT"));
});
test("keyword-rank SQP rejects a row-cap (truncation) result in the builder", () => {
  assert.ok(/Search Query Performance export reached the/.test(DD), "fetchSqpRows must reject a row-cap result");
});
test("content-changes events is a NO-DATE source; catalog is a 365-day range", () => {
  const ev = byKey(content, "content-changes:events");
  assert.deepEqual(ev.columns, constArray("CONTENT_CHANGE_COLUMNS"));
  assert.equal(ev.limit, constNumber("CONTENT_CHANGE_ROW_LIMIT"));
  assert.equal(ev.orderByColumn, "event_time");
  assert.equal(ev.orderByDirection, "DESC");
  assert.ok(/no-date/i.test(ev.windowKind));
  assert.ok(/HTTP 424/.test(ev.orgAvailability));
  const cat = byKey(content, "content-changes:catalog");
  assert.deepEqual(cat.columns, constArray("PRODUCT_CATALOG_COLUMNS"));
  assert.equal(cat.limit, constNumber("CATALOG_ROW_LIMIT"));
});
test("keyword-rank resolves weekly+monthly+catalog; the two SQP cadences are distinct sources/hashes", () => {
  const got = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "k", ids: ["A1"], windowsByRequestKey: kwWin });
  assert.equal(got.length, 3);
  const wk = got.find((r) => r.requestKey === "keyword-rank:sqp-weekly");
  const mo = got.find((r) => r.requestKey === "keyword-rank:sqp-monthly");
  assert.notEqual(wk.sourceId, mo.sourceId);
  assert.notEqual(wk.requestHash, mo.requestHash);
});
test("content-changes no-date events request carries null from/to and never inherits the catalog dates", () => {
  const got = reportSourceRequestHashes({ reportKey: "content-changes", apiKey: "k", ids: ["A1"], windowsByRequestKey: ccWin });
  const ev = got.find((r) => r.requestKey === "content-changes:events");
  const cat = got.find((r) => r.requestKey === "content-changes:catalog");
  assert.equal(ev.from, null);
  assert.equal(ev.to, null);
  assert.equal(ev.requestMeta.from, null);
  assert.equal(ev.requestMeta.to, null);
  assert.equal(cat.from, "2024-08-06");
});
test("keyword-rank primary vs dd-secondary org isolation", () => {
  const p = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "primary-key", ids: ["A1"], windowsByRequestKey: kwWin });
  const s = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "secondary-key", ids: ["A1"], windowsByRequestKey: kwWin });
  for (let i = 0; i < p.length; i += 1) assert.notEqual(p[i].requestHash, s[i].requestHash);
});
for (const n of [0, 1, 5, 6, 11]) {
  test(`keyword-rank reproduces the transport chunks + hashes for ${n} IDs`, () => {
    const got = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "primary", ids: ids(n), windowsByRequestKey: kwWin });
    const exp = transportExpected("keyword-rank", "primary", ids(n), kwWin);
    assert.equal(got.length, exp.length);
    for (let i = 0; i < exp.length; i += 1) {
      assert.deepEqual(got[i].sellerOrVendorIds, exp[i].sellerOrVendorIds);
      assert.equal(got[i].requestHash, exp[i].requestHash);
    }
  });
}

/* ===================== FIX 1: Daily strict cap ===================== */

test("rejectsAtCap accepts 49,999 and rejects exactly 50,000 (and above)", () => {
  assert.equal(rejectsAtCap(49999, 50000), false);
  assert.equal(rejectsAtCap(50000, 50000), true);
  assert.equal(rejectsAtCap(50001, 50000), true);
  assert.equal(rejectsAtCap(0, 50000), false);
});

test("Daily ASIN/day superset contract is marked strict:true", () => {
  assert.equal(byKey(daily, "daily-reporting:asin-day-superset").strict, true);
});

test("fetchDailyBrandSalesRows enforces the row cap in executable code (rejects before append)", () => {
  const start = DD.indexOf("async function fetchDailyBrandSalesRows");
  assert.ok(start > 0, "fetchDailyBrandSalesRows must exist");
  const body = DD.slice(start, DD.indexOf("\n}\n", start));
  assert.ok(/rows\.length >= DAILY_BRAND_ROW_LIMIT/.test(body), "must guard rows.length >= DAILY_BRAND_ROW_LIMIT");
  assert.ok(/throw new Error/.test(body), "a capped month must throw, not append");
  // The throw is placed BEFORE the append so a rejected month contributes no rows.
  assert.ok(body.indexOf("rows.length >= DAILY_BRAND_ROW_LIMIT") < body.indexOf("allRows.push"), "reject must precede append");
});

test("every strict:true contract is backed by an executable rows.length >= LIMIT guard", () => {
  // machine-readable strict flag must never claim a safeguard the builder lacks.
  const STRICT = {
    "daily-reporting:asin-day-superset": "DAILY_BRAND_ROW_LIMIT",
    "sku-pl:monthly-profit": "SKU_PL_ROW_LIMIT",
    "keyword-rank:sqp-weekly": "SQP_ROW_LIMIT",
    "keyword-rank:sqp-monthly": "SQP_ROW_LIMIT",
    "reconciliation:order-lines": "RECONCILIATION_ROW_LIMIT",
    "reconciliation:settlements": "RECONCILIATION_ROW_LIMIT",
  };
  const declaredStrict = [];
  for (const key of declaredReportKeys()) {
    for (const c of REPORT_SOURCE_CONTRACTS[key]) if (c.strict) declaredStrict.push(c.requestKey);
  }
  // exactly the intended set is marked strict — no unbacked strict labels.
  assert.deepEqual(declaredStrict.sort(), Object.keys(STRICT).sort());
  for (const [, constName] of Object.entries(STRICT)) {
    assert.ok(new RegExp("rows\\.length >= " + constName).test(DD), "missing executable guard for " + constName);
  }
});

console.log("\n" + passed + " assertions passed");
