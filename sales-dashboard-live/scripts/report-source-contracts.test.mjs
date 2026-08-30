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
  REPORT_DERIVED_ONLY,
  REPORT_DERIVATION,
  REPORT_SOURCE_CONTRACTS,
  reportSourceRequestHashes,
  declaredReportKeys,
  declaredRequestKeys,
  reportSourceCoverage,
  rejectsAtCap,
  evaluateFallbackCondition,
  sourceDisabledOutcome,
  normalizeAvailabilityPolicy,
  validateStagedSignal,
  evaluateStagedActivation,
  salesMoversWindows,
  isValidCalendarDate,
  validateAdsCurrencySignal,
  evaluateAdsCurrencyGate,
  normalizeFailurePolicy,
  REPORT_SOURCE_SCOPE,
  reportAccountScope,
  requiresSingleAccountSource,
} from "../lib/server/sync/report-source-contracts.js";
import { REPORT_SOURCE_REQUIREMENTS, sourceContractForKey } from "../lib/server/source-contracts.js";
import { failedAdsCurrencySignal } from "../lib/server/sync/source-signals.js";
import { sourceRequestIdentity } from "../lib/server/source-identity.js";
import { canonicalOliSlices, planMonthWindows } from "../lib/server/date-windows.js";
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

/* ---- insight builders: read the real column/aggregation constants out of the
   executable builder files (lib/server/reports/*.js). Same parity discipline as
   the operational reports, but the constants live in the builders, not datadoe.js. ---- */
const REPORTS_DIR = join(ROOT, "lib", "server", "reports");
const builderCache = new Map();
function builderText(file) {
  if (!builderCache.has(file)) builderCache.set(file, readFileSync(join(REPORTS_DIR, file), "utf8"));
  return builderCache.get(file);
}
function arrFrom(text, name) {
  const start = text.indexOf("const " + name + " = [");
  if (start < 0) throw new Error("const " + name + " not found");
  const open = text.indexOf("[", start);
  const close = text.indexOf("];", open);
  return [...text.slice(open + 1, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}
function aggsFrom(text, name) {
  const start = text.indexOf("const " + name + " = [");
  if (start < 0) throw new Error("const " + name + " (aggregations) not found");
  const close = text.indexOf("];", start);
  return [...text.slice(start, close).matchAll(/\{\s*column:\s*"([^"]+)",\s*aggregation:\s*"([^"]+)",\s*alias:\s*"([^"]+)"\s*\}/g)]
    .map((m) => ({ column: m[1], aggregation: m[2], alias: m[3] }));
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
    // "exactly cover" is a SET relationship (a requirements list may order derived
    // sources before owned ones, e.g. PPC lists its Ads sources first), so compare
    // as sets and assert no source is over- or under-represented.
    assert.deepEqual([...represented].sort(), [...required].sort(), key + " must represent every required source exactly");
    assert.equal(represented.length, required.length, key + " must not duplicate or omit a source");
    assert.ok(reportSourceCoverage(key), key + " must declare its coverage status");
  }
  assert.deepEqual(declaredRequestKeys("brand-sales"), ["brand-sales:order-lines", "brand-sales:catalog"]);
  assert.equal(declaredRequestKeys("brand-view"), null); // derived-only report: no owned source jobs
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

test("a derived-only report (no owned source jobs) resolves to null", () => {
  assert.equal(reportSourceRequestHashes({ reportKey: "brand-view", apiKey: "k", ids: ids(3), windowsByRequestKey: {} }), null);
  assert.equal(reportSourceRequestHashes({ reportKey: "priority-feed", apiKey: "k", ids: ids(3), windowsByRequestKey: {} }), null);
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
  // sku-pl is account-scoped (Blocker 4): a single account, so one request per window.
  const got = reportSourceRequestHashes({ reportKey: "sku-pl", apiKey: "k", ids: ["A1"], windowsByRequestKey: { "sku-pl:monthly-profit": months } });
  assert.equal(got.length, 3); // 1 source x 3 windows x 1 chunk (one account)
  assert.equal(new Set(got.map((r) => r.requestHash)).size, 3);
  assert.deepEqual(got.map((r) => ({ from: r.from, to: r.to })), months);
});

/* ---- Blocker 4: report source-scope policy (single-account contracts) ---- */

test("source-scope policy: daily-reporting and sku-pl are single-account; others multi-account", () => {
  assert.equal(REPORT_SOURCE_SCOPE["daily-reporting"], "single-account");
  assert.equal(REPORT_SOURCE_SCOPE["sku-pl"], "single-account");
  assert.equal(reportAccountScope("daily-reporting"), "single-account");
  assert.equal(reportAccountScope("sku-pl"), "single-account");
  assert.equal(requiresSingleAccountSource("sku-pl"), true);
  assert.equal(requiresSingleAccountSource("daily-reporting"), true);
  // Every other report keeps safe five-ID batching.
  assert.equal(reportAccountScope("brand-sales"), "multi-account");
  assert.equal(requiresSingleAccountSource("brand-sales"), false);
  assert.equal(requiresSingleAccountSource("keyword-rank"), false);
});

test("sku-pl rejects a multi-account scope (grouped rows carry no seller/vendor partition key)", () => {
  const months = [{ from: "2025-06-01", to: "2025-06-30" }];
  // One account resolves normally.
  const one = reportSourceRequestHashes({ reportKey: "sku-pl", apiKey: "k", ids: ["A1"], windowsByRequestKey: { "sku-pl:monthly-profit": months } });
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].sellerOrVendorIds, ["A1"]);
  // Two accounts (two raw ids) are rejected fail-closed.
  assert.throws(
    () => reportSourceRequestHashes({ reportKey: "sku-pl", apiKey: "k", ids: ["A1", "A2"], windowsByRequestKey: { "sku-pl:monthly-profit": months } }),
    /account-scoped and must resolve a single account/,
  );
});

test("daily-reporting rejects a multi-account scope; single account resolves", () => {
  const dailyWin = {
    "daily-reporting:oli-sales": canonicalOliSlices("2025-05-01", "2025-05-31"),
    "daily-reporting:catalog": [{ from: "2025-05-01", to: "2025-05-31" }],
  };
  const one = reportSourceRequestHashes({ reportKey: "daily-reporting", apiKey: "k", ids: ["A1"], windowsByRequestKey: dailyWin });
  assert.ok(one.length >= 1 && one.every((r) => r.sellerOrVendorIds.length === 1));
  assert.throws(
    () => reportSourceRequestHashes({ reportKey: "daily-reporting", apiKey: "k", ids: ["A1", "A2"], windowsByRequestKey: dailyWin }),
    /account-scoped and must resolve a single account/,
  );
});

test("single-account rejection does NOT disable five-ID batching for other reports", () => {
  // brand-sales still batches 6 ids into two chunks (unchanged).
  const got = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: ids(6), windowsByRequestKey: bsWin });
  const ol = got.filter((r) => r.requestKey === "brand-sales:order-lines");
  assert.equal(ol.length, 2, "6 ids -> two five-ID chunks preserved for multi-account reports");
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

const FBA_ASOF = "2025-08-06";
const fbaPlanMonths = planMonthWindows(FBA_ASOF); // completed[0].from = 2025-05-01, current.to = asOf
const fbaOliSlices = canonicalOliSlices(fbaPlanMonths.completed[0].from, FBA_ASOF);
const fbaBase = {
  // OLI sales + Product Catalog are DERIVED durable deps for fba-plan (no owned export), so they are NOT resolved
  // here. Only the FBA Inventory Health snapshot (all markets) + the US-only AWD listing are owned exports.
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

/* --- executable parity: daily-reporting (canonical OLI sales superset + catalog) --- */
test("daily-reporting oli-sales superset matches the canonical OLI fragment (DAILY_BRAND_SALES_* = OLI_SALES_*)", () => {
  const c = byKey(daily, "daily-reporting:oli-sales");
  assert.deepEqual(c.columns, constArray("DAILY_BRAND_SALES_COLUMNS"));
  assert.deepEqual(c.groupBy, constArray("DAILY_BRAND_SALES_GROUP_BY"));
  assert.deepEqual(c.aggregations, constAggregations("DAILY_SALES_AGGREGATIONS"));
  // Blocker 1: the daily superset IS the canonical OLI sales fragment (byte-identical to OLI_SALES_*).
  assert.deepEqual(c.columns, constArray("OLI_SALES_COLUMNS"));
  assert.deepEqual(c.aggregations, constAggregations("OLI_SALES_AGGREGATIONS"));
  assert.equal(c.limit, constNumber("DAILY_BRAND_ROW_LIMIT")); // strict per-slice cap
  // Blocker 1: sliced by canonicalOliSlices (calendar-anchored bins) so interior + asOf-boundary slices
  // share request_hashes with fba-plan / buy-box-loss / returns-leakage / ppc-performance.
  assert.ok(c.windowKind.startsWith("canonicalOliSlices"), "superset must be sliced by canonicalOliSlices");
});
test("daily-reporting catalog matches PRODUCT_CATALOG_COLUMNS + CATALOG_ROW_LIMIT; no compact all-brand export", () => {
  const c = byKey(daily, "daily-reporting:catalog");
  assert.deepEqual(c.columns, constArray("PRODUCT_CATALOG_COLUMNS"));
  assert.equal(c.limit, constNumber("CATALOG_ROW_LIMIT"));
  assert.equal(c.groupBy, null);
  // No per-brand and no compact all-brand export: exactly two owned exports.
  assert.equal(daily.length, 2);
  assert.deepEqual(daily.map((x) => x.requestKey), ["daily-reporting:oli-sales", "daily-reporting:catalog"]);
  // Ads remain a derived dependency, not an owned export -- now the ASIN grain (single reusable Ads source).
  assert.ok((REPORT_DERIVED_SOURCE_KEYS["daily-reporting"] || []).includes("ads-asin-date"));
  assert.ok(!(REPORT_DERIVED_SOURCE_KEYS["daily-reporting"] || []).includes("ads-campaign-date"), "campaign grain is PPC-only now");
});
test("daily-reporting derivation strategy derives all-brand + named-brand from the superset (no per-brand export)", () => {
  const d = REPORT_DERIVATION["daily-reporting"];
  assert.ok(d && Array.isArray(d.derivedFrom));
  assert.deepEqual(d.derivedFrom, ["daily-reporting:oli-sales", "daily-reporting:catalog"]);
  assert.ok(d.outputs.includes("all-brand"));
  assert.ok(/no per-brand export/i.test(d.strategy));
  // Structural token-saving proof: the ASIN/day builder is the ONE canonical OLI superset fetch, so a
  // named-brand report never triggers its own per-brand DataDoe export. Blocker 1: it is sliced by
  // canonicalOliSlices (calendar-anchored bins), NOT splitDateRangeByMonth, so its interior + asOf-boundary
  // slices share request_hashes with fba-plan / buy-box-loss / returns-leakage / ppc-performance.
  assert.ok(DD.includes("async function fetchDailyBrandSalesRows"));
  const fdBody = DD.slice(DD.indexOf("async function fetchDailyBrandSalesRows"));
  assert.ok(/for \(const window of canonicalOliSlices\(from, to\)\)/.test(fdBody), "named-brand fetch must be sliced by canonicalOliSlices");
  assert.ok(!/splitDateRangeByMonth/.test(fdBody.slice(0, fdBody.indexOf("\n}\n"))), "named-brand fetch must NOT use splitDateRangeByMonth");
});

/* --- executable parity: fba-plan (OLI + catalog are DERIVED durable deps; only FBA Health + AWD are owned) --- */
test("fba-plan owns NO OLI/catalog contract (both are durable derived deps)", () => {
  assert.equal(byKey(fba, "fba-plan:oli-sales"), undefined, "fba-plan:oli-sales is not an owned contract");
  assert.equal(byKey(fba, "fba-plan:catalog"), undefined, "fba-plan:catalog is not an owned contract");
  // The two owned contracts remain FBA Health + AWD.
  assert.ok(byKey(fba, "fba-plan:inventory-health"), "fba-plan:inventory-health is owned");
  assert.ok(byKey(fba, "fba-plan:awd"), "fba-plan:awd is owned");
});
test("fba-plan inventory-health / awd match their constants (both now seller-scoped for marketplace-safe batching)", () => {
  const inv = byKey(fba, "fba-plan:inventory-health");
  // The scheduler-v2 contract carries the marketplace-safe batch-split key seller_or_vendor_id IN ADDITION to the
  // route's FBA_HEALTH_COLUMNS. The derive IGNORES that column (fbaPlanPayload never reads it), so the derived
  // payload stays byte-identical to the route -- only the fetch identity gains the split key needed to batch.
  assert.ok(inv.columns.includes("seller_or_vendor_id"), "batchable FBA Health contract carries the seller split key");
  assert.deepEqual(inv.columns.filter((c) => c !== "seller_or_vendor_id"), constArray("FBA_HEALTH_COLUMNS"));
  assert.equal(inv.limit, constNumber("PLAN_INVENTORY_ROW_LIMIT"));
  assert.equal(inv.orderByColumn, "date");
  assert.equal(inv.orderByDirection, "DESC");
  const awd = byKey(fba, "fba-plan:awd");
  assert.ok(awd.columns.includes("seller_or_vendor_id"), "batchable AWD contract carries the seller split key");
  assert.deepEqual(awd.columns.filter((c) => c !== "seller_or_vendor_id"), constArray("LISTINGS_AWD_COLUMNS"));
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
test("fba-plan resolves ONLY its owned FBA Health + US AWD sources (OLI/catalog are durable derived)", () => {
  const got = reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids: ["A1"], windowsByRequestKey: fbaWithAwd, marketplaceCountry: "US" });
  assert.equal(got.filter((r) => r.requestKey === "fba-plan:oli-sales").length, 0, "no owned OLI fragments");
  assert.equal(got.filter((r) => r.requestKey === "fba-plan:catalog").length, 0, "no owned catalog fragment");
  assert.equal(got.filter((r) => r.requestKey === "fba-plan:inventory-health").length, 1);
  assert.equal(got.filter((r) => r.requestKey === "fba-plan:awd").length, 1);
  assert.equal(got.length, 2);
});

/* --- country-driven US-only AWD --- */
test("fba-plan resolves without AWD for a non-US account", () => {
  const got = reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids: ["A1"], windowsByRequestKey: fbaBase, marketplaceCountry: "IN" });
  assert.equal(got.length, 1); // only the owned FBA Health snapshot (OLI/catalog derived; no AWD for non-US)
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
  // A US fba-plan with only AWD supplied is missing its required FBA Health snapshot window -> throws.
  assert.throws(() => reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids: ["A1"], windowsByRequestKey: { "fba-plan:awd": [{ from: null, to: null }] }, marketplaceCountry: "US" }), /Missing windows/);
});

/* ===================== keyword-rank + content-changes ===================== */

const keyword = REPORT_SOURCE_CONTRACTS["keyword-rank"];
const content = REPORT_SOURCE_CONTRACTS["content-changes"];
// Kickoff windows: weekly primary + catalog only (monthly fallback not planned).
const kwKickoff = {
  "keyword-rank:sqp-weekly": [{ from: "2025-05-14", to: "2025-08-06" }],
  "keyword-rank:catalog": [{ from: "2024-08-06", to: "2025-08-06" }],
};
// Fallback windows: all three keys (weekly + monthly + catalog).
const kwFallbackWin = { ...kwKickoff, "keyword-rank:sqp-monthly": [{ from: "2024-08-06", to: "2025-08-06" }] };
// Typed, validated fallback signals (status/validated/distinctPeriods).
const SIG_LOW = { "keyword-rank:sqp-weekly": { status: "success", validated: true, distinctPeriods: 2 } };  // < 4 => monthly active
const SIG_HIGH = { "keyword-rank:sqp-weekly": { status: "success", validated: true, distinctPeriods: 4 } }; // >= 4 => monthly inactive
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
  const cat = byKey(content, "content-changes:catalog");
  assert.deepEqual(cat.columns, constArray("PRODUCT_CATALOG_COLUMNS"));
  assert.equal(cat.limit, constNumber("CATALOG_ROW_LIMIT"));
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

/* ===================== FIX 2: keyword monthly data-dependent fallback ===================== */

test("sqp-monthly contract carries typed fallback metadata (not a parsed string)", () => {
  const mo = byKey(keyword, "keyword-rank:sqp-monthly");
  assert.equal(mo.dependencyMode, "fallback");
  assert.equal(mo.dependsOnRequestKey, "keyword-rank:sqp-weekly");
  assert.deepEqual(mo.condition, { type: "distinct_periods_lt", value: 4 });
});
test("evaluateFallbackCondition: only a VALIDATED fresh/last-known-good weekly under threshold activates monthly", () => {
  const cond = { type: "distinct_periods_lt", value: 4 };
  const sig = (o) => ({ status: "success", validated: true, distinctPeriods: 0, ...o });
  // validated fresh success by period count
  assert.equal(evaluateFallbackCondition(cond, sig({ distinctPeriods: 0 })), true);
  assert.equal(evaluateFallbackCondition(cond, sig({ distinctPeriods: 3 })), true);
  assert.equal(evaluateFallbackCondition(cond, sig({ distinctPeriods: 4 })), false);
  assert.equal(evaluateFallbackCondition(cond, sig({ distinctPeriods: 9 })), false);
  // validated last-known-good
  assert.equal(evaluateFallbackCondition(cond, sig({ status: "last-known-good", distinctPeriods: 2 })), true);
  assert.equal(evaluateFallbackCondition(cond, sig({ status: "last-known-good", distinctPeriods: 5 })), false);
  // failed / terminal / unvalidated => never schedule (preserve prior report)
  assert.equal(evaluateFallbackCondition(cond, { status: "failed", validated: false, distinctPeriods: null }), false);
  assert.equal(evaluateFallbackCondition(cond, { status: "terminal", validated: false, distinctPeriods: null }), false);
  assert.equal(evaluateFallbackCondition(cond, { status: "success", validated: false, distinctPeriods: 2 }), false);
});
test("evaluateFallbackCondition FAILS CLOSED on malformed signal / condition / threshold / periods", () => {
  const cond = { type: "distinct_periods_lt", value: 4 };
  const good = { status: "success", validated: true, distinctPeriods: 2 };
  assert.throws(() => evaluateFallbackCondition(cond, null), /Fallback signal must be an object/);
  assert.throws(() => evaluateFallbackCondition(cond, { validated: true, distinctPeriods: 2 }), /status/);
  assert.throws(() => evaluateFallbackCondition(cond, { status: "success", distinctPeriods: 2 }), /validated must be a boolean/);
  assert.throws(() => evaluateFallbackCondition(cond, { status: "success", validated: true, distinctPeriods: -1 }), /distinctPeriods/);
  assert.throws(() => evaluateFallbackCondition(cond, { status: "success", validated: true, distinctPeriods: 1.5 }), /distinctPeriods/);
  assert.throws(() => evaluateFallbackCondition(cond, { status: "success", validated: true, distinctPeriods: null }), /numeric distinctPeriods/);
  assert.throws(() => evaluateFallbackCondition({ type: "wat", value: 4 }, good), /Unsupported fallback condition type/);
  assert.throws(() => evaluateFallbackCondition({ type: "distinct_periods_lt", value: -1 }, good), /threshold/);
  assert.throws(() => evaluateFallbackCondition({}, good), /typed object/);
});
test("kickoff (no signals) plans weekly + catalog only — NO monthly source job", () => {
  const got = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "k", ids: ["A1"], windowsByRequestKey: kwKickoff });
  assert.deepEqual(got.map((r) => r.requestKey).sort(), ["keyword-rank:catalog", "keyword-rank:sqp-weekly"]);
  assert.ok(!got.some((r) => r.requestKey === "keyword-rank:sqp-monthly"));
});
test("weekly with 4+ periods creates no monthly source job (and rejects a stray monthly window)", () => {
  const got = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "k", ids: ["A1"], windowsByRequestKey: kwKickoff, fallbackSignals: SIG_HIGH });
  assert.ok(!got.some((r) => r.requestKey === "keyword-rank:sqp-monthly"));
  assert.throws(
    () => reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "k", ids: ["A1"], windowsByRequestKey: kwFallbackWin, fallbackSignals: SIG_HIGH }),
    /does not apply/,
  );
});
test("weekly with 0-3 periods creates EXACTLY ONE monthly source job", () => {
  const got = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "k", ids: ["A1"], windowsByRequestKey: kwFallbackWin, fallbackSignals: SIG_LOW });
  const monthly = got.filter((r) => r.requestKey === "keyword-rank:sqp-monthly");
  assert.equal(monthly.length, 1);
  assert.equal(got.length, 3); // weekly + monthly + catalog, single chunk
});
test("repeated planning does not duplicate the monthly job (deterministic)", () => {
  const a = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "k", ids: ["A1"], windowsByRequestKey: kwFallbackWin, fallbackSignals: SIG_LOW });
  const b = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "k", ids: ["A1"], windowsByRequestKey: kwFallbackWin, fallbackSignals: SIG_LOW });
  assert.deepEqual(a.map((r) => r.requestHash), b.map((r) => r.requestHash));
  assert.equal(a.filter((r) => r.requestKey === "keyword-rank:sqp-monthly").length, 1);
  // The one-create-export-per-cycle guard is unique(cycle_id, request_hash) +
  // claim_source_export_attempt (proven in scheduler-v2.test.mjs): identical monthly
  // request_hash across repeated worker calls collapses to one DataDoe export.
});
test("failed weekly WITHOUT a validated last-known-good does NOT schedule monthly (prior report preserved)", () => {
  const failedNoLkg = { "keyword-rank:sqp-weekly": { status: "failed", validated: false, distinctPeriods: null } };
  const got = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "k", ids: ["A1"], windowsByRequestKey: kwKickoff, fallbackSignals: failedNoLkg });
  assert.ok(!got.some((r) => r.requestKey === "keyword-rank:sqp-monthly"));
});
test("validated last-known-good weekly with 0-3 periods DOES schedule monthly", () => {
  const lkg = { "keyword-rank:sqp-weekly": { status: "last-known-good", validated: true, distinctPeriods: 1 } };
  const got = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "k", ids: ["A1"], windowsByRequestKey: kwFallbackWin, fallbackSignals: lkg });
  assert.equal(got.filter((r) => r.requestKey === "keyword-rank:sqp-monthly").length, 1);
});
test("terminal/disabled weekly does NOT schedule monthly; weekly policy blocks Keyword Rank", () => {
  const terminal = { "keyword-rank:sqp-weekly": { status: "terminal", validated: false, distinctPeriods: null } };
  const got = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "k", ids: ["A1"], windowsByRequestKey: kwKickoff, fallbackSignals: terminal });
  assert.ok(!got.some((r) => r.requestKey === "keyword-rank:sqp-monthly"));
  const wk = got.find((r) => r.requestKey === "keyword-rank:sqp-weekly");
  assert.equal(sourceDisabledOutcome(wk.availabilityPolicy).blocks, true);
});
test("a malformed fallback signal makes the resolver throw a safe configuration error", () => {
  const bad = { "keyword-rank:sqp-weekly": { distinctPeriods: 2 } }; // missing status/validated
  assert.throws(
    () => reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "k", ids: ["A1"], windowsByRequestKey: kwFallbackWin, fallbackSignals: bad }),
    /status/,
  );
});
test("keyword weekly + monthly cadences are distinct sources/hashes when monthly is active", () => {
  const got = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "k", ids: ["A1"], windowsByRequestKey: kwFallbackWin, fallbackSignals: SIG_LOW });
  const wk = got.find((r) => r.requestKey === "keyword-rank:sqp-weekly");
  const mo = got.find((r) => r.requestKey === "keyword-rank:sqp-monthly");
  assert.notEqual(wk.sourceId, mo.sourceId);
  assert.notEqual(wk.requestHash, mo.requestHash);
});
test("keyword-rank primary vs dd-secondary org isolation (kickoff + fallback)", () => {
  for (const [win, sig] of [[kwKickoff, undefined], [kwFallbackWin, SIG_LOW]]) {
    const p = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "primary-key", ids: ["A1"], windowsByRequestKey: win, fallbackSignals: sig });
    const s = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "secondary-key", ids: ["A1"], windowsByRequestKey: win, fallbackSignals: sig });
    for (let i = 0; i < p.length; i += 1) assert.notEqual(p[i].requestHash, s[i].requestHash);
  }
});
for (const n of [0, 1, 5, 6, 11]) {
  test(`keyword-rank reproduces the transport chunks + hashes for ${n} IDs (fallback active)`, () => {
    const got = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "primary", ids: ids(n), windowsByRequestKey: kwFallbackWin, fallbackSignals: SIG_LOW });
    const exp = transportExpected("keyword-rank", "primary", ids(n), kwFallbackWin);
    assert.equal(got.length, exp.length);
    for (let i = 0; i < exp.length; i += 1) {
      assert.deepEqual(got[i].sellerOrVendorIds, exp[i].sellerOrVendorIds);
      assert.equal(got[i].requestHash, exp[i].requestHash);
    }
  });
}

/* ===================== FIX 3: structured source-failure policy ===================== */

test("every conditional (org-availability) source has a structured availabilityPolicy; none parses HTTP 424", () => {
  const conditional = [
    ["keyword-rank", "keyword-rank:sqp-weekly"],
    ["keyword-rank", "keyword-rank:sqp-monthly"],
    ["content-changes", "content-changes:events"],
    ["listing-health", "listing-health:listings-raw"], // degraded (optional enrichment)
    ["listing-optimizer", "listing-optimizer:sqp-weekly"], // degraded (valid sqpAvailable:false snapshot)
  ];
  for (const [rk, key] of conditional) {
    const c = byKey(REPORT_SOURCE_CONTRACTS[rk], key);
    assert.ok(c.availabilityPolicy && typeof c.availabilityPolicy === "object", key + " needs availabilityPolicy");
    assert.equal(c.availabilityPolicy.safeCode, "SOURCE_DISABLED");
    assert.ok(["terminal", "degraded"].includes(c.availabilityPolicy.disabledSource));
    assert.ok(["blocked", "save-unavailable-snapshot"].includes(c.availabilityPolicy.reportOutcome));
    assert.equal(c.orgAvailability, undefined, key + " must not keep the old descriptive string");
  }
  // No scheduler contract may depend on parsing an HTTP status string.
  const dump = JSON.stringify(REPORT_SOURCE_CONTRACTS);
  assert.ok(!/424/.test(dump), "no contract field may contain 424");
  assert.ok(!/orgAvailability/.test(dump), "no contract may keep orgAvailability");
});
test("sourceDisabledOutcome: terminal blocks the report; degraded saves an unavailable snapshot", () => {
  const terminal = sourceDisabledOutcome({ disabledSource: "terminal", safeCode: "SOURCE_DISABLED", reportOutcome: "blocked" });
  const degraded = sourceDisabledOutcome({ disabledSource: "degraded", safeCode: "SOURCE_DISABLED", reportOutcome: "save-unavailable-snapshot" });
  assert.equal(terminal.blocks, true);
  assert.equal(terminal.reportOutcome, "blocked");
  assert.equal(degraded.blocks, false); // degraded permits valid report derivation
  assert.equal(degraded.reportOutcome, "save-unavailable-snapshot");
  assert.notEqual(terminal.blocks, degraded.blocks); // terminal and degraded are distinct
});
test("keyword-rank's declared conditional sources are all terminal (report blocked when disabled)", () => {
  for (const key of ["keyword-rank:sqp-weekly", "keyword-rank:sqp-monthly"]) {
    assert.equal(sourceDisabledOutcome(byKey(keyword, key).availabilityPolicy).blocks, true);
  }
  assert.equal(sourceDisabledOutcome(byKey(content, "content-changes:events").availabilityPolicy).blocks, true);
});

/* ===================== FIX 1: Daily strict cap ===================== */

test("rejectsAtCap accepts 49,999 and rejects exactly 50,000 (and above)", () => {
  assert.equal(rejectsAtCap(49999, 50000), false);
  assert.equal(rejectsAtCap(50000, 50000), true);
  assert.equal(rejectsAtCap(50001, 50000), true);
  assert.equal(rejectsAtCap(0, 50000), false);
});

test("Daily canonical OLI sales superset contract is marked strict:true", () => {
  assert.equal(byKey(daily, "daily-reporting:oli-sales").strict, true);
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
  // Operational reports guard with a named per-report LIMIT constant in api/datadoe.js.
  const OPERATIONAL_STRICT = {
    "daily-reporting:oli-sales": "DAILY_BRAND_ROW_LIMIT",
    "sku-pl:monthly-profit": "SKU_PL_ROW_LIMIT",
    "keyword-rank:sqp-weekly": "SQP_ROW_LIMIT",
    "keyword-rank:sqp-monthly": "SQP_ROW_LIMIT",
    "reconciliation:order-lines": "RECONCILIATION_ROW_LIMIT",
    "reconciliation:settlements": "RECONCILIATION_ROW_LIMIT",
  };
  // Insight reports fetch through the shared fetchExportRowsStrict transport, whose
  // generic guard rejects rows.length >= limit. Each strict insight request maps to
  // the builder file that issues the strict fetch (common.js for the shared
  // catalog/inventory helpers). The Sales Movers latest-date probe is deliberately
  // NOT strict (a date rollup never nears its 500 cap), so it is absent here.
  const INSIGHT_STRICT = {
    "sales-movers:traffic": "sales-movers.js",
    "sales-movers:ads": "sales-movers.js",
    "sales-movers:inventory": "common.js",
    "sales-movers:catalog": "common.js",
    "buy-box-loss:daily": "buy-box.js",
    "buy-box-loss:oli-sales": "buy-box.js",
    "buy-box-loss:inventory": "common.js",
    "buy-box-loss:catalog": "common.js",
    "returns-leakage:returns": "returns.js",
    "returns-leakage:settlements": "returns.js",
    "returns-leakage:oli-sales": "returns.js",
    "returns-leakage:catalog": "common.js",
    "listing-health:listings": "listing-health.js",
    "listing-health:listings-raw": "listing-health.js",
    "listing-health:sales": "listing-health.js",
    "listing-health:inventory": "common.js",
    "listing-health:catalog": "common.js",
    "ppc-performance:oli-sales": "ppc.js",
    "ppc-performance:catalog": "common.js",
    "listing-optimizer:sqp-weekly": "listing-optimizer.js",
    "listing-optimizer:catalog": "listing-optimizer.js",
  };
  // Scheduler-v2 INTEGRITY strictness (separate from the legacy route-backed sets above). These
  // contracts are strict at the SCHEDULER boundary even though the legacy api/datadoe.js / App.jsx route
  // fetches them non-strict: a cap-sized page for any of them (understated FBA sales/stock, a missing
  // AWD/inventory ASIN, a catalog that turns known products into "Unassigned", or a truncated DESC content-
  // change stream that drops the newest events) is indistinguishable from truncation. They are deliberately
  // NOT backed by a route rows.length>=LIMIT guard -- the source worker enforces the cap (asserted below),
  // so they must NOT be added to OPERATIONAL_STRICT. Brand Sales + Content Changes join this set in the
  // Phase 1e re-review (their canonical Scheduler-v2 dispatch is strict even though the live route is not).
  const SCHEDULER_V2_STRICT = [
    "reconciliation:catalog",
    // fba-plan's OLI + catalog are durable derived deps now (no owned export); only its FBA Health + AWD remain.
    "fba-plan:inventory-health", "fba-plan:awd",
    "brand-sales:order-lines", "brand-sales:catalog",
    "content-changes:events", "content-changes:catalog",
  ];
  const routeBacked = new Set([...Object.keys(OPERATIONAL_STRICT), ...Object.keys(INSIGHT_STRICT)]);
  // The categories are disjoint: a strict key is EITHER route-backed OR scheduler-only, never both.
  for (const k of SCHEDULER_V2_STRICT) assert.ok(!routeBacked.has(k), k + " is scheduler-only strict, not route-backed");
  const declaredStrict = [];
  for (const key of declaredReportKeys()) {
    for (const c of REPORT_SOURCE_CONTRACTS[key]) if (c.strict) declaredStrict.push(c.requestKey);
  }
  // exactly the intended set is marked strict — no unbacked strict labels.
  assert.deepEqual(declaredStrict.sort(), [...routeBacked, ...SCHEDULER_V2_STRICT].sort());
  // Legacy route guards (unchanged): operational reports guard with a named per-report LIMIT constant.
  for (const [, constName] of Object.entries(OPERATIONAL_STRICT)) {
    assert.ok(new RegExp("rows\\.length >= " + constName).test(DD), "missing executable guard for " + constName);
  }
  // Scheduler-v2-only strict contracts are backed by the SOURCE WORKER's cap guard (NOT a route
  // guard): a strict job whose result reaches the row cap fails as TRUNCATED before any save.
  const worker = readFileSync(join(ROOT, "lib", "server", "sync", "source-worker.js"), "utf8");
  assert.ok(/job\.strict === true && rows\.length >= Number\(job\.limit\)/.test(worker), "source worker must enforce the strict row cap");
  assert.ok(/"TRUNCATED"/.test(worker), "the strict cap failure is recorded as TRUNCATED");
  // The shared strict transport really enforces the cap, and every strict insight
  // request is issued through it.
  const transport = readFileSync(join(ROOT, "lib", "server", "datadoe.js"), "utf8");
  const gi = transport.indexOf("function fetchExportRowsStrict");
  assert.ok(gi > 0 && /rows\.length >= limit/.test(transport.slice(gi, gi + 500)),
    "fetchExportRowsStrict must guard rows.length >= limit");
  for (const [rk, file] of Object.entries(INSIGHT_STRICT)) {
    assert.ok(/fetchExportRowsStrict\s*\(/.test(builderText(file)),
      rk + " must fetch through fetchExportRowsStrict (" + file + ")");
  }
});

/* ============ re-review FIX 1: execution policy on concrete resolved jobs ============ */

test("resolved jobs carry an explicit strict boolean + availabilityPolicy (null when N/A)", () => {
  const got = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "k", ids: ["A1"], windowsByRequestKey: kwKickoff });
  const wk = got.find((r) => r.requestKey === "keyword-rank:sqp-weekly");   // strict + terminal policy
  const cat = got.find((r) => r.requestKey === "keyword-rank:catalog");     // neither
  assert.equal(wk.strict, true);
  assert.deepEqual(wk.availabilityPolicy, { disabledSource: "terminal", safeCode: "SOURCE_DISABLED", reportOutcome: "blocked" });
  assert.equal(cat.strict, false); // explicit boolean, never undefined
  assert.equal(cat.availabilityPolicy, null);
});
test("every resolved job has strict:boolean, availabilityPolicy:(object|null), and no HTTP 424", () => {
  const jobs = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "k", ids: ["A1", "A2"], windowsByRequestKey: kwFallbackWin, fallbackSignals: SIG_LOW });
  for (const j of jobs) {
    assert.equal(typeof j.strict, "boolean");
    assert.ok(j.availabilityPolicy === null || typeof j.availabilityPolicy === "object");
    assert.ok(!/424/.test(JSON.stringify(j.availabilityPolicy)));
  }
});
test("normalizeAvailabilityPolicy: terminal vs degraded distinct; rejects bad enum / HTTP strings", () => {
  const deg = normalizeAvailabilityPolicy({ disabledSource: "degraded", safeCode: "SOURCE_DISABLED", reportOutcome: "save-unavailable-snapshot" });
  const term = normalizeAvailabilityPolicy({ disabledSource: "terminal", safeCode: "SOURCE_DISABLED", reportOutcome: "blocked" });
  assert.equal(normalizeAvailabilityPolicy(null), null);
  assert.equal(sourceDisabledOutcome(deg).blocks, false); // degraded permits derivation
  assert.equal(sourceDisabledOutcome(term).blocks, true);
  assert.notEqual(deg.disabledSource, term.disabledSource);
  assert.throws(() => normalizeAvailabilityPolicy({ disabledSource: "wat", safeCode: "x", reportOutcome: "blocked" }), /disabledSource/);
  assert.throws(() => normalizeAvailabilityPolicy({ disabledSource: "terminal", safeCode: "SOURCE_DISABLED", reportOutcome: "nope" }), /reportOutcome/);
  assert.throws(() => normalizeAvailabilityPolicy({ disabledSource: "terminal", safeCode: "HTTP 424", reportOutcome: "blocked" }), /HTTP status/);
});
test("availabilityPolicy enforces the only two valid pairs (crossed combinations rejected)", () => {
  // valid pairs accepted
  assert.deepEqual(normalizeAvailabilityPolicy({ disabledSource: "terminal", safeCode: "SOURCE_DISABLED", reportOutcome: "blocked" }),
    { disabledSource: "terminal", safeCode: "SOURCE_DISABLED", reportOutcome: "blocked" });
  assert.deepEqual(normalizeAvailabilityPolicy({ disabledSource: "degraded", safeCode: "SOURCE_DISABLED", reportOutcome: "save-unavailable-snapshot" }),
    { disabledSource: "degraded", safeCode: "SOURCE_DISABLED", reportOutcome: "save-unavailable-snapshot" });
  // crossed pairs rejected (contradictory worker instructions)
  assert.throws(() => normalizeAvailabilityPolicy({ disabledSource: "terminal", safeCode: "SOURCE_DISABLED", reportOutcome: "save-unavailable-snapshot" }), /Contradictory availabilityPolicy/);
  assert.throws(() => normalizeAvailabilityPolicy({ disabledSource: "degraded", safeCode: "SOURCE_DISABLED", reportOutcome: "blocked" }), /Contradictory availabilityPolicy/);
});
test("sourceDisabledOutcome enforces the SAME invariant (rejects crossed pairs; null => blocked)", () => {
  // shares normalizeAvailabilityPolicy, so contradictory pairs fail closed here too
  assert.throws(() => sourceDisabledOutcome({ disabledSource: "terminal", safeCode: "SOURCE_DISABLED", reportOutcome: "save-unavailable-snapshot" }), /Contradictory availabilityPolicy/);
  assert.throws(() => sourceDisabledOutcome({ disabledSource: "degraded", safeCode: "SOURCE_DISABLED", reportOutcome: "blocked" }), /Contradictory availabilityPolicy/);
  // null/no-policy stays safe: a disabled default-dataset source is treated as blocked
  assert.deepEqual(sourceDisabledOutcome(null), { blocks: true, safeCode: "SOURCE_DISABLED", reportOutcome: "blocked" });
  // consistent outcomes for the valid pairs
  assert.equal(sourceDisabledOutcome({ disabledSource: "terminal", safeCode: "SOURCE_DISABLED", reportOutcome: "blocked" }).blocks, true);
  assert.equal(sourceDisabledOutcome({ disabledSource: "degraded", safeCode: "SOURCE_DISABLED", reportOutcome: "save-unavailable-snapshot" }).blocks, false);
});
test("mutating a returned job's execution policy cannot mutate REPORT_SOURCE_CONTRACTS", () => {
  const before = JSON.stringify(REPORT_SOURCE_CONTRACTS["keyword-rank"]);
  const wk = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "k", ids: ["A1"], windowsByRequestKey: kwKickoff })
    .find((r) => r.requestKey === "keyword-rank:sqp-weekly");
  try { wk.availabilityPolicy.disabledSource = "degraded"; } catch (e) { /* frozen */ }
  try { wk.strict = false; } catch (e) { /* primitive copy */ }
  assert.equal(REPORT_SOURCE_CONTRACTS["keyword-rank"][0].availabilityPolicy.disabledSource, "terminal");
  assert.equal(REPORT_SOURCE_CONTRACTS["keyword-rank"][0].strict, true);
  assert.equal(JSON.stringify(REPORT_SOURCE_CONTRACTS["keyword-rank"]), before);
});
test("execution metadata does NOT change request_hash (identity ignores strict/policy)", () => {
  const job = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "k", ids: ["A1"], windowsByRequestKey: kwKickoff })
    .find((r) => r.requestKey === "keyword-rank:sqp-weekly");
  const expected = sourceRequestIdentity({
    apiKey: "k", sourceId: job.sourceId, columns: byKey(keyword, "keyword-rank:sqp-weekly").columns,
    ids: job.sellerOrVendorIds, from: job.from, to: job.to, limit: job.limit, options: job.options,
  }).requestHash;
  assert.equal(job.requestHash, expected);
});

/* ---- Scheduler-v2 integrity strictness: FBA + reconciliation:catalog resolved jobs ---- */

test("Scheduler-v2 integrity: every fba-plan resolved job + reconciliation:catalog is strict:true", () => {
  const fbaJobs = reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids: ["A1"], windowsByRequestKey: fbaWithAwd, marketplaceCountry: "US" });
  for (const rk of ["fba-plan:inventory-health", "fba-plan:awd"]) {
    const jobs = fbaJobs.filter((j) => j.requestKey === rk);
    assert.ok(jobs.length >= 1, rk + " must resolve at least one job");
    for (const j of jobs) assert.equal(j.strict, true, rk + " resolved job must be strict:true");
  }
  const recJobs = reportSourceRequestHashes({ reportKey: "reconciliation", apiKey: "k", ids: ["A1"], windowsByRequestKey: reconWin });
  assert.equal(recJobs.find((j) => j.requestKey === "reconciliation:catalog").strict, true);
  // The reconciliation order/settlement contracts were already strict (route-backed); still true.
  assert.equal(recJobs.find((j) => j.requestKey === "reconciliation:order-lines").strict, true);
});

test("Scheduler-v2 strict metadata does NOT change fba-plan / reconciliation request_hash", () => {
  const fbaJobs = reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids: ["A1"], windowsByRequestKey: fbaWithAwd, marketplaceCountry: "US" });
  for (const j of fbaJobs) {
    const expected = sourceRequestIdentity({
      apiKey: "k", sourceId: j.sourceId, columns: byKey(fba, j.requestKey).columns,
      ids: j.sellerOrVendorIds, from: j.from, to: j.to, limit: j.limit, options: j.options,
    }).requestHash;
    assert.equal(j.requestHash, expected, j.requestKey + " request_hash must ignore the strict flag");
  }
  const recCat = reportSourceRequestHashes({ reportKey: "reconciliation", apiKey: "k", ids: ["A1"], windowsByRequestKey: reconWin }).find((j) => j.requestKey === "reconciliation:catalog");
  const recExpected = sourceRequestIdentity({
    apiKey: "k", sourceId: recCat.sourceId, columns: byKey(recon, "reconciliation:catalog").columns,
    ids: recCat.sellerOrVendorIds, from: recCat.from, to: recCat.to, limit: recCat.limit, options: recCat.options,
  }).requestHash;
  assert.equal(recCat.requestHash, recExpected);
});

/* =================== Insight reports: Sales Movers / Buy Box / Returns =================== */

// requestKey -> expected executable source (builder file + constant names + fetch params).
// Constants are read out of the builders so a drift in either place fails the test.
const INSIGHT_SPEC = [
  { rk: "sales-movers:traffic", file: "sales-movers.js", cols: "TRAFFIC_COLUMNS", group: "TRAFFIC_COLUMNS", aggs: "TRAFFIC_AGGREGATIONS", src: "sales-traffic-asin-date", limit: 50000, oc: "child_asin", od: "ASC", strict: true },
  { rk: "sales-movers:ads", file: "sales-movers.js", cols: "ADS_COLUMNS", group: "ADS_COLUMNS", aggs: "ADS_AGGREGATIONS", src: "profit-by-sku-date", limit: 50000, oc: "child_asin", od: "ASC", strict: true },
  { rk: "sales-movers:inventory", file: "common.js", cols: "INVENTORY_COLUMNS", group: null, aggs: null, src: "fba-inventory-health", limit: 15000, oc: "date", od: "DESC", strict: true },
  { rk: "sales-movers:catalog", file: "common.js", cols: "CATALOG_COLUMNS", group: null, aggs: null, src: "product-catalog", limit: 20000, oc: "child_asin", od: "ASC", strict: true },
  { rk: "buy-box-loss:daily", file: "buy-box.js", cols: "DAILY_COLUMNS", group: null, aggs: null, src: "profit-by-sku-date", limit: 50000, oc: "date", od: "ASC", strict: true },
  { rk: "buy-box-loss:oli-sales", file: "buy-box.js", cols: "OLI_SALES_GROUP_BY", group: "OLI_SALES_GROUP_BY", aggs: "OLI_SALES_AGGREGATIONS", src: "order-line-items", limit: 5000, oc: "date", od: "ASC", strict: true },
  { rk: "buy-box-loss:inventory", file: "common.js", cols: "INVENTORY_COLUMNS", group: null, aggs: null, src: "fba-inventory-health", limit: 15000, oc: "date", od: "DESC", strict: true },
  { rk: "buy-box-loss:catalog", file: "common.js", cols: "CATALOG_COLUMNS", group: null, aggs: null, src: "product-catalog", limit: 20000, oc: "child_asin", od: "ASC", strict: true },
  { rk: "returns-leakage:returns", file: "returns.js", cols: "RETURN_COLUMNS", group: null, aggs: null, src: "returns", limit: 50000, oc: "date", od: "DESC", strict: true },
  { rk: "returns-leakage:settlements", file: "returns.js", cols: "SETTLEMENT_GROUP_BY", group: "SETTLEMENT_GROUP_BY", aggs: "SETTLEMENT_AGGREGATIONS", src: "settlements", limit: 50000, oc: "sku", od: "ASC", strict: true },
  { rk: "returns-leakage:oli-sales", file: "returns.js", cols: "OLI_SALES_GROUP_BY", group: "OLI_SALES_GROUP_BY", aggs: "OLI_SALES_AGGREGATIONS", src: "order-line-items", limit: 5000, oc: "date", od: "ASC", strict: true },
  { rk: "returns-leakage:catalog", file: "common.js", cols: "CATALOG_COLUMNS", group: null, aggs: null, src: "product-catalog", limit: 20000, oc: "child_asin", od: "ASC", strict: true },
  // Listing Health
  { rk: "listing-health:listings", file: "listing-health.js", cols: "LISTING_COLUMNS", group: null, aggs: null, src: "listings", limit: 20000, oc: "child_asin", od: "ASC", strict: true },
  { rk: "listing-health:listings-raw", file: "listing-health.js", cols: "LISTING_RAW_COLUMNS", group: null, aggs: null, src: "listings-raw", limit: 20000, oc: "child_asin", od: "ASC", strict: true, policy: "degraded" },
  { rk: "listing-health:sales", file: "listing-health.js", cols: "SALES_COLUMNS", group: "SALES_COLUMNS", aggs: "SALES_AGGREGATIONS", src: "profit-by-sku-date", limit: 50000, oc: "sku", od: "ASC", strict: true },
  { rk: "listing-health:inventory", file: "common.js", cols: "INVENTORY_COLUMNS", group: null, aggs: null, src: "fba-inventory-health", limit: 15000, oc: "date", od: "DESC", strict: true },
  { rk: "listing-health:catalog", file: "common.js", cols: "CATALOG_COLUMNS", group: null, aggs: null, src: "product-catalog", limit: 20000, oc: "child_asin", od: "ASC", strict: true },
  // PPC Performance (ads are derived; this is the only owned export besides catalog)
  { rk: "ppc-performance:oli-sales", file: "ppc.js", cols: "OLI_SALES_GROUP_BY", group: "OLI_SALES_GROUP_BY", aggs: "OLI_SALES_AGGREGATIONS", src: "order-line-items", limit: 5000, oc: "date", od: "ASC", strict: true },
  { rk: "ppc-performance:catalog", file: "common.js", cols: "CATALOG_COLUMNS", group: null, aggs: null, src: "product-catalog", limit: 20000, oc: "child_asin", od: "ASC", strict: true },
  // Listing Optimizer (richer SQP + richer content catalog; both intentionally unshared)
  { rk: "listing-optimizer:sqp-weekly", file: "listing-optimizer.js", cols: "SQP_COLUMNS", group: null, aggs: null, src: "sqp-weekly", limit: 50000, oc: "date", od: "ASC", strict: true, policy: "degraded" },
  { rk: "listing-optimizer:catalog", file: "listing-optimizer.js", cols: "CATALOG_CONTENT_COLUMNS", group: null, aggs: null, src: "product-catalog", limit: 20000, oc: "child_asin", od: "ASC", strict: true },
];

const DEGRADED_POLICY = { disabledSource: "degraded", safeCode: "SOURCE_DISABLED", reportOutcome: "save-unavailable-snapshot" };

test("insight contracts (all six reports) match their executable builder constants", () => {
  for (const s of INSIGHT_SPEC) {
    const c = byKey(REPORT_SOURCE_CONTRACTS[s.rk.split(":")[0]], s.rk);
    assert.ok(c, s.rk + " must be declared");
    const txt = builderText(s.file);
    assert.deepEqual(c.columns, arrFrom(txt, s.cols), s.rk + " columns");                       // (1) exact columns
    assert.deepEqual(c.groupBy, s.group ? arrFrom(txt, s.group) : null, s.rk + " groupBy");        // (2) exact groupBy
    assert.deepEqual(c.aggregations, s.aggs ? aggsFrom(txt, s.aggs) : null, s.rk + " aggregations");// (2) exact aggregations
    assert.equal(c.sourceKey, s.src, s.rk + " sourceKey");                                          // (3) exact source key
    assert.ok(sourceContractForKey(s.src), s.src + " must be a known source contract");            // (3) resolves to a real source
    assert.equal(c.limit, s.limit, s.rk + " limit");                                               // (4) exact limit
    assert.equal(c.orderByColumn, s.oc, s.rk + " orderByColumn");                                   // (4) exact ordering
    assert.equal(c.orderByDirection, s.od, s.rk + " orderByDirection");
    assert.equal(Boolean(c.strict), Boolean(s.strict), s.rk + " strict flag");                      // (6) strict flag
    if (s.policy === "degraded") {                                                                  // (7) optional source degrades
      assert.deepEqual(c.availabilityPolicy, DEGRADED_POLICY, s.rk + " must carry the degraded policy");
      assert.equal(sourceDisabledOutcome(c.availabilityPolicy).blocks, false, s.rk + " must NOT block the cycle");
    } else {                                                                                        // (8) required/default source: no policy
      assert.equal(c.availabilityPolicy, undefined, s.rk + " must have no availabilityPolicy");
    }
  }
});

test("sales-movers latest-date probe is a NON-strict date rollup (limit 500) matching fetchSalesTrafficLatestDate", () => {
  const c = byKey(REPORT_SOURCE_CONTRACTS["sales-movers"], "sales-movers:sales-latest-probe");
  assert.deepEqual(c.columns, ["date"]);
  assert.deepEqual(c.groupBy, ["date"]);
  assert.deepEqual(c.aggregations, [{ column: "total_units", aggregation: "sum", alias: "units_sum" }]);
  assert.equal(c.limit, 500);
  assert.equal(c.sourceKey, "sales-traffic-asin-date");
  assert.notEqual(c.strict, true); // the one insight request that is intentionally not strict
  const common = builderText("common.js");
  const probe = common.slice(common.indexOf("function fetchSalesTrafficLatestDate"));
  assert.ok(/fetchExportRows\(/.test(probe) && !/fetchExportRowsStrict\(/.test(probe.slice(0, probe.indexOf("}"))), "probe uses non-strict fetchExportRows");
  assert.ok(/ROW_LIMITS\.dateRollup/.test(probe));
});

// Concrete per-requestKey windows (no Cartesian products): traffic/ads carry TWO
// weekly windows; buy-box daily carries FOUR 7-day slices; catalog is no-date.
const smWin = {
  "sales-movers:sales-latest-probe": [{ from: "2025-07-12", to: "2025-08-06" }],
  "sales-movers:traffic": [{ from: "2025-07-24", to: "2025-07-30" }, { from: "2025-07-17", to: "2025-07-23" }],
  "sales-movers:ads": [{ from: "2025-07-24", to: "2025-07-30" }, { from: "2025-07-17", to: "2025-07-23" }],
  "sales-movers:inventory": [{ from: "2025-07-27", to: "2025-08-06" }],
  "sales-movers:catalog": [{ from: null, to: null }],
};
const bbWin = {
  "buy-box-loss:daily": [
    { from: "2025-07-10", to: "2025-07-16" }, { from: "2025-07-17", to: "2025-07-23" },
    { from: "2025-07-24", to: "2025-07-30" }, { from: "2025-07-31", to: "2025-08-06" },
  ],
  // Blocker 1: canonical OLI sales fragment sliced by canonicalOliSlices over the buy-box 28-day window.
  "buy-box-loss:oli-sales": canonicalOliSlices("2025-07-10", "2025-08-06"),
  "buy-box-loss:inventory": [{ from: "2025-07-27", to: "2025-08-06" }],
  "buy-box-loss:catalog": [{ from: null, to: null }],
};
const retWin = {
  "returns-leakage:returns": [{ from: "2025-06-08", to: "2025-08-06" }],
  "returns-leakage:settlements": [{ from: "2025-06-08", to: "2025-08-06" }],
  // Blocker 1: canonical OLI sales fragment sliced by canonicalOliSlices over the returns 60-day window.
  "returns-leakage:oli-sales": canonicalOliSlices("2025-06-08", "2025-08-06"),
  "returns-leakage:catalog": [{ from: null, to: null }],
};

// Typed signals that activate the staged / gated downstream jobs. `smWin` traffic/ads
// windows are exactly salesMoversWindows("2025-07-30").
const SM_PROBE_OK = { "sales-movers:sales-latest-probe": { status: "success", validated: true, latestReportedDate: "2025-07-30" } };
const OPT_SQP_OK = { "listing-optimizer:sqp-weekly": { status: "success", validated: true } };
const PPC_CUR_OK = { "ppc-performance:ads-currency": { status: "success", validated: true, currencyCount: 1, state: "single-valid" } };

for (const [rep, win, sig] of [["sales-movers", smWin, SM_PROBE_OK], ["buy-box-loss", bbWin, undefined], ["returns-leakage", retWin, undefined]]) {
  for (const n of [0, 1, 5, 6, 11]) {
    test(`${rep} resolver reproduces the transport chunks + hashes for ${n} IDs`, () => {
      const got = reportSourceRequestHashes({ reportKey: rep, apiKey: "k", ids: ids(n), windowsByRequestKey: win, dependencySignals: sig });
      if (n === 0) { assert.deepEqual(got, []); return; } // (17) empty scope returns []
      const exp = transportExpected(rep, "k", ids(n), win);
      assert.equal(got.length, exp.length, "same request count");
      const key = (r) => [r.requestKey, r.from, r.to, r.sellerOrVendorIds.join(",")].join("|");
      const gm = new Map(got.map((r) => [key(r), r.requestHash]));
      for (const e of exp) assert.equal(gm.get(key(e)), e.requestHash, e.requestKey + " hash mismatch"); // (10)
    });
  }
}

test("sales-movers traffic + ads each resolve to exactly their 2 windows; probe/inventory/catalog do not inherit them", () => {
  const got = reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "k", ids: ["A1"], windowsByRequestKey: smWin, dependencySignals: SM_PROBE_OK });
  assert.equal(got.filter((r) => r.requestKey === "sales-movers:traffic").length, 2);
  assert.equal(got.filter((r) => r.requestKey === "sales-movers:ads").length, 2);
  const traffic = got.filter((r) => r.requestKey === "sales-movers:traffic");
  assert.notEqual(traffic[0].requestHash, traffic[1].requestHash); // recent != prior
  const cat = got.find((r) => r.requestKey === "sales-movers:catalog");
  assert.equal(cat.from, null); assert.equal(cat.to, null); // (5) no-date request keeps null dates
  assert.equal(got.filter((r) => r.requestKey === "sales-movers:catalog").length, 1);
});

test("buy-box-loss daily resolves to one request per 7-day slice (4 slices; additive, not multiplied)", () => {
  const got = reportSourceRequestHashes({ reportKey: "buy-box-loss", apiKey: "k", ids: ["A1"], windowsByRequestKey: bbWin });
  const daily = got.filter((r) => r.requestKey === "buy-box-loss:daily");
  assert.equal(daily.length, 4);
  assert.equal(new Set(daily.map((r) => r.requestHash)).size, 4); // four distinct slice identities
  assert.equal(got.filter((r) => r.requestKey === "buy-box-loss:inventory").length, 1);
});

test("(12) the common insight catalog is ONE request identity shared across Sales Movers / Buy Box / Returns", () => {
  const cat = (rep, win, sig) => reportSourceRequestHashes({ reportKey: rep, apiKey: "k", ids: ["A1"], windowsByRequestKey: win, dependencySignals: sig })
    .find((r) => r.requestKey.endsWith(":catalog")).requestHash;
  const h1 = cat("sales-movers", smWin, SM_PROBE_OK), h2 = cat("buy-box-loss", bbWin), h3 = cat("returns-leakage", retWin);
  assert.equal(h1, h2); assert.equal(h2, h3); // identical columns/limit/window/order => fetched once
});

test("(12) the FBA inventory snapshot is ONE request identity shared by Sales Movers + Buy Box", () => {
  const inv = (rep, win, sig) => reportSourceRequestHashes({ reportKey: rep, apiKey: "k", ids: ["A1"], windowsByRequestKey: win, dependencySignals: sig })
    .find((r) => r.requestKey.endsWith(":inventory")).requestHash;
  assert.equal(inv("sales-movers", smWin, SM_PROBE_OK), inv("buy-box-loss", bbWin));
});

test("(Blocker 1) Buy Box + Returns SHARE the same request_hash on an overlapping canonical OLI slice (one export, many owners)", () => {
  const bb = reportSourceRequestHashes({ reportKey: "buy-box-loss", apiKey: "k", ids: ["A1"], windowsByRequestKey: bbWin }).filter((r) => r.requestKey === "buy-box-loss:oli-sales");
  const ret = reportSourceRequestHashes({ reportKey: "returns-leakage", apiKey: "k", ids: ["A1"], windowsByRequestKey: retWin }).filter((r) => r.requestKey === "returns-leakage:oli-sales");
  // A calendar-anchored interior slice that BOTH the 28-day and 60-day windows fully cover.
  const shared = { from: "2025-07-22", to: "2025-07-28" };
  const bbSlice = bb.find((r) => r.from === shared.from && r.to === shared.to);
  const retSlice = ret.find((r) => r.from === shared.from && r.to === shared.to);
  assert.ok(bbSlice && retSlice, "both reports emit the shared interior slice");
  assert.equal(bbSlice.sourceId, retSlice.sourceId); // same Order Line Items source id...
  assert.equal(bbSlice.requestHash, retSlice.requestHash); // ...and IDENTICAL canonical spec + window => ONE export shared by both owners
});

test("(11) sales-movers primary vs dd-secondary organizations remain isolated (different hashes)", () => {
  const primary = reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "PRIMARY_ORG_KEY", ids: ["A1"], windowsByRequestKey: smWin, dependencySignals: SM_PROBE_OK });
  const secondary = reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "DD_SECONDARY_ORG_KEY", ids: ["A1"], windowsByRequestKey: smWin, dependencySignals: SM_PROBE_OK });
  assert.equal(primary.length, secondary.length);
  for (let i = 0; i < primary.length; i++) assert.notEqual(primary[i].requestHash, secondary[i].requestHash);
});

test("(16/17) insight resolver fails closed: empty scope => [], missing declared window => throws", () => {
  assert.deepEqual(reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "k", ids: [], windowsByRequestKey: {} }), []);
  // With the probe validated (all downstream active), a missing window for an active
  // request throws for the right reason.
  const partial = { ...smWin }; delete partial["sales-movers:traffic"];
  assert.throws(() => reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "k", ids: ["A1"], windowsByRequestKey: partial, dependencySignals: SM_PROBE_OK }), /Missing windows/);
});

/* =============== Insight reports: Listing Health / PPC / Listing Optimizer =============== */

const lhWin = {
  "listing-health:listings": [{ from: null, to: null }],
  "listing-health:listings-raw": [{ from: null, to: null }],
  "listing-health:sales": [{ from: "2025-07-08", to: "2025-08-06" }],
  "listing-health:inventory": [{ from: "2025-07-27", to: "2025-08-06" }],
  "listing-health:catalog": [{ from: null, to: null }],
};
const ppcWin = {
  // Blocker 1: canonical OLI sales fragment sliced by canonicalOliSlices over the ppc 30-day window.
  "ppc-performance:oli-sales": canonicalOliSlices("2025-07-08", "2025-08-06"),
  "ppc-performance:catalog": [{ from: null, to: null }],
};
const optWin = {
  "listing-optimizer:sqp-weekly": [{ from: "2025-05-14", to: "2025-08-06" }],
  "listing-optimizer:catalog": [{ from: null, to: null }],
};

for (const [rep, win, sig] of [["listing-health", lhWin, undefined], ["ppc-performance", ppcWin, PPC_CUR_OK], ["listing-optimizer", optWin, OPT_SQP_OK]]) {
  for (const n of [0, 1, 5, 6, 11]) {
    test(`${rep} resolver reproduces the transport chunks + hashes for ${n} IDs`, () => {
      const got = reportSourceRequestHashes({ reportKey: rep, apiKey: "k", ids: ids(n), windowsByRequestKey: win, dependencySignals: sig });
      if (n === 0) { assert.deepEqual(got, []); return; } // (17) empty scope
      const exp = transportExpected(rep, "k", ids(n), win);
      assert.equal(got.length, exp.length, "same request count");
      const key = (r) => [r.requestKey, r.from, r.to, r.sellerOrVendorIds.join(",")].join("|");
      const gm = new Map(got.map((r) => [key(r), r.requestHash]));
      for (const e of exp) assert.equal(gm.get(key(e)), e.requestHash, e.requestKey + " hash mismatch"); // (10)
    });
  }
}

test("(9) resolved insight jobs carry a strict boolean + normalized availabilityPolicy (degraded => blocks:false)", () => {
  const jobs = reportSourceRequestHashes({ reportKey: "listing-health", apiKey: "k", ids: ["A1", "A2", "A3", "A4", "A5", "A6"], windowsByRequestKey: lhWin });
  const raw = jobs.find((r) => r.requestKey === "listing-health:listings-raw");
  const cat = jobs.find((r) => r.requestKey === "listing-health:catalog");
  assert.equal(raw.strict, true);
  assert.deepEqual(raw.availabilityPolicy, DEGRADED_POLICY);           // (9) frozen degraded policy on the job
  assert.equal(sourceDisabledOutcome(raw.availabilityPolicy).blocks, false); // degraded never blocks the cycle
  assert.equal(cat.strict, true);
  assert.equal(cat.availabilityPolicy, null);                          // required source: explicit null, not undefined
  const opt = reportSourceRequestHashes({ reportKey: "listing-optimizer", apiKey: "k", ids: ["A1"], windowsByRequestKey: optWin, dependencySignals: OPT_SQP_OK })
    .find((r) => r.requestKey === "listing-optimizer:sqp-weekly");
  assert.deepEqual(opt.availabilityPolicy, DEGRADED_POLICY);
});

test("(13) Listing Optimizer's catalog and SQP do NOT deduplicate with the common catalog / Keyword Rank SQP", () => {
  const hashAt = (c, from, to) => sourceRequestIdentity({
    apiKey: "k", sourceId: sourceContractForKey(c.sourceKey).ids[0], columns: c.columns, ids: ["A1"],
    from, to, limit: c.limit, options: { orderByColumn: c.orderByColumn, orderByDirection: c.orderByDirection },
  }).requestHash;
  const optCat = byKey(REPORT_SOURCE_CONTRACTS["listing-optimizer"], "listing-optimizer:catalog");
  const commonCat = byKey(REPORT_SOURCE_CONTRACTS["sales-movers"], "sales-movers:catalog");
  assert.equal(optCat.sourceKey, commonCat.sourceKey);         // same product-catalog source...
  assert.notDeepEqual(optCat.columns, commonCat.columns);      // ...richer content columns...
  assert.notEqual(hashAt(optCat, null, null), hashAt(commonCat, null, null)); // ...so a distinct identity at the SAME no-date window
  const optSqp = byKey(REPORT_SOURCE_CONTRACTS["listing-optimizer"], "listing-optimizer:sqp-weekly");
  const kwSqp = byKey(REPORT_SOURCE_CONTRACTS["keyword-rank"], "keyword-rank:sqp-weekly");
  assert.equal(optSqp.sourceKey, kwSqp.sourceKey);             // same sqp-weekly source...
  assert.notDeepEqual(optSqp.columns, kwSqp.columns);          // ...different column set...
  assert.notEqual(hashAt(optSqp, "2025-05-14", "2025-08-06"), hashAt(kwSqp, "2025-05-14", "2025-08-06")); // ...distinct even at one window
});

test("(14) PPC creates NO Ads DataDoe source jobs; ads are declared derived from persisted rows", () => {
  const jobs = reportSourceRequestHashes({ reportKey: "ppc-performance", apiKey: "k", ids: ["A1"], windowsByRequestKey: ppcWin, dependencySignals: PPC_CUR_OK });
  assert.deepEqual([...new Set(jobs.map((j) => j.requestKey))].sort(), ["ppc-performance:catalog", "ppc-performance:oli-sales"]);
  for (const c of REPORT_SOURCE_CONTRACTS["ppc-performance"]) assert.ok(!/^ads-/.test(c.sourceKey), "PPC owns no Ads source");
  assert.deepEqual(REPORT_DERIVED_SOURCE_KEYS["ppc-performance"], ["ads-campaign-date", "ads-asin-date", "ads-targeting-date", "ads-search-terms-date"]);
  assert.ok(/getAdsDailySourceRows/.test(builderText("ppc.js")), "PPC builder must read persisted ads rows, not fetch an export");
});

test("(15) Priority Feed and Brand View are derived-only: no owned contracts, resolver returns null", () => {
  for (const k of ["priority-feed", "brand-view"]) {
    assert.equal(REPORT_SOURCE_CONTRACTS[k], undefined, k + " must own no source contracts");
    assert.equal(reportSourceRequestHashes({ reportKey: k, apiKey: "k", ids: ["A1"], windowsByRequestKey: {} }), null);
    assert.ok(REPORT_DERIVED_ONLY.includes(k), k + " must be registered derived-only");
  }
});

test("(dependency map) every report is scheduler-source-declared OR explicitly derived-only (none unaudited)", () => {
  const declared = new Set(declaredReportKeys());
  const derivedOnly = new Set(REPORT_DERIVED_ONLY);
  for (const k of derivedOnly) assert.ok(!declared.has(k), k + " cannot be both declared and derived-only");
  for (const key of Object.keys(REPORT_SOURCE_REQUIREMENTS)) {
    assert.ok(declared.has(key) || derivedOnly.has(key), key + " is neither scheduler-declared nor derived-only");
  }
  for (const k of derivedOnly) {
    assert.equal(REPORT_SOURCE_CONTRACTS[k], undefined, k + " must own no source contracts");
    assert.equal(reportSourceRequestHashes({ reportKey: k, apiKey: "k", ids: ["A1"], windowsByRequestKey: {} }), null);
  }
});

/* ================= FIX 1/2/3: staged dependencies + failure policy ================= */

const keysOf = (jobs) => [...new Set(jobs.map((j) => j.requestKey))].sort();
const smProbeWin = { "sales-movers:sales-latest-probe": [{ from: "2025-07-12", to: "2025-08-06" }] };
const optSqpWin = { "listing-optimizer:sqp-weekly": [{ from: "2025-05-14", to: "2025-08-06" }] };
const ppcCatOnly = { "ppc-performance:catalog": [{ from: null, to: null }] };

/* ---- typed models ---- */

test("salesMoversWindows derives recent/prior 7-day weeks from the latest date (calendar-independent)", () => {
  assert.deepEqual(salesMoversWindows("2025-07-30"),
    { recent: { from: "2025-07-24", to: "2025-07-30" }, prior: { from: "2025-07-17", to: "2025-07-23" } });
  assert.throws(() => salesMoversWindows("2025/07/30"), /calendar date/);
  assert.throws(() => salesMoversWindows(null), /calendar date/);
});

test("staged signal + activation are typed and fail closed", () => {
  assert.throws(() => validateStagedSignal({ status: "nope", validated: true }), /status/);
  assert.throws(() => validateStagedSignal({ status: "success", validated: "yes" }), /validated/);
  assert.throws(() => validateStagedSignal({ status: "success", validated: true, latestReportedDate: "bad" }), /YYYY-MM-DD/);
  const act = { type: "validated_success", requireReportedDate: true };
  assert.equal(evaluateStagedActivation(act, { status: "success", validated: true, latestReportedDate: "2025-07-30" }), true);
  assert.equal(evaluateStagedActivation(act, { status: "success", validated: true, latestReportedDate: null }), false); // no data
  assert.equal(evaluateStagedActivation(act, { status: "last-known-good", validated: true, latestReportedDate: "2025-07-30" }), false); // conservative
  assert.equal(evaluateStagedActivation({ type: "validated_success" }, { status: "success", validated: false }), false); // unvalidated
  assert.throws(() => evaluateStagedActivation(act, { status: "success", validated: true }), /requires latestReportedDate/); // fail closed
  assert.throws(() => evaluateStagedActivation({ type: "bogus" }, { status: "success", validated: true }), /Unsupported staged activation/);
});

test("ads-currency signal + gate are typed and fail closed", () => {
  assert.throws(() => validateAdsCurrencySignal({ status: "success", validated: true, currencyCount: 1.5 }), /currencyCount/);
  assert.throws(() => validateAdsCurrencySignal({ status: "bogus", validated: true, currencyCount: 1 }), /status/);
  // Blocker 1: `state` is a REQUIRED, typed field (one of the four evidence literals).
  assert.throws(() => validateAdsCurrencySignal({ status: "success", validated: true, currencyCount: 1 }), /state/); // missing state
  assert.throws(() => validateAdsCurrencySignal({ status: "success", validated: true, currencyCount: 1, state: "bogus" }), /state/); // bad state literal
  // The gate passes ONLY for a single valid canonical currency; empty/invalid/multiple all fail closed.
  assert.equal(evaluateAdsCurrencyGate({ status: "success", validated: true, currencyCount: 1, state: "single-valid" }), true);
  assert.equal(evaluateAdsCurrencyGate({ status: "success", validated: true, currencyCount: 0, state: "empty" }), false); // empty: no ads currency to match
  assert.equal(evaluateAdsCurrencyGate({ status: "success", validated: true, currencyCount: 1, state: "invalid" }), false); // any blank/malformed row
  assert.equal(evaluateAdsCurrencyGate({ status: "success", validated: true, currencyCount: 2, state: "multiple" }), false); // by design
  assert.equal(evaluateAdsCurrencyGate({ status: "failed", validated: true, currencyCount: 1, state: "single-valid" }), false);
  assert.equal(evaluateAdsCurrencyGate({ status: "success", validated: false, currencyCount: 1, state: "single-valid" }), false); // fail closed
  // Blocker 2: the ONE shared failedAdsCurrencySignal() producer emits a typed shape that VALIDATES (no throw)
  // and gates OFF -- every unavailable/read-failed ads-currency signal is typed-consistent by construction.
  assert.deepEqual(failedAdsCurrencySignal(), { status: "failed", validated: false, currencyCount: 0, state: "invalid" });
  assert.doesNotThrow(() => validateAdsCurrencySignal(failedAdsCurrencySignal()));
  assert.equal(evaluateAdsCurrencyGate(failedAdsCurrencySignal()), false);
});

test("normalizeFailurePolicy validates enums, rejects HTTP-code text, freezes the result", () => {
  assert.equal(normalizeFailurePolicy(null), null);
  assert.throws(() => normalizeFailurePolicy({ onFailure: "block", degradedScope: "x", safeCode: "Y" }), /onFailure/);
  assert.throws(() => normalizeFailurePolicy({ onFailure: "degrade", degradedScope: "", safeCode: "Y" }), /degradedScope/);
  assert.throws(() => normalizeFailurePolicy({ onFailure: "degrade", degradedScope: "x", safeCode: "HTTP 429" }), /HTTP status/);
  const p = normalizeFailurePolicy({ onFailure: "degrade", degradedScope: "tacos-denominator", safeCode: "TOTAL_SALES_UNAVAILABLE" });
  assert.ok(Object.isFrozen(p));
  assert.equal(p.blocks, false); assert.equal(p.neverPartial, true);
  assert.ok(p.causes.includes("strict-row-cap") && p.causes.includes("http-4xx") && p.causes.includes("source-save-error"));
});

/* ---- FIX 1: Sales Movers staged dependency state table ---- */

test("Sales Movers — kickoff plans ONLY the latest-date probe (no downstream exports)", () => {
  const jobs = reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "k", ids: ["A1"], windowsByRequestKey: smProbeWin });
  assert.deepEqual(keysOf(jobs), ["sales-movers:sales-latest-probe"]);
  assert.equal(jobs[0].dependency, null); // the probe itself is unconditional
});

test("Sales Movers — fresh validated probe with a date activates downstream with DERIVED windows + dependency metadata", () => {
  const w = salesMoversWindows("2025-07-30");
  const win = {
    "sales-movers:sales-latest-probe": [{ from: "2025-07-12", to: "2025-08-06" }],
    "sales-movers:traffic": [w.recent, w.prior],
    "sales-movers:ads": [w.recent, w.prior],
    "sales-movers:inventory": [{ from: "2025-07-27", to: "2025-08-06" }],
    "sales-movers:catalog": [{ from: null, to: null }],
  };
  const jobs = reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "k", ids: ["A1"], windowsByRequestKey: win, dependencySignals: SM_PROBE_OK });
  assert.deepEqual(keysOf(jobs), ["sales-movers:ads", "sales-movers:catalog", "sales-movers:inventory", "sales-movers:sales-latest-probe", "sales-movers:traffic"]);
  const traffic = jobs.filter((j) => j.requestKey === "sales-movers:traffic");
  assert.deepEqual(traffic.map((j) => [j.from, j.to]).sort(), [["2025-07-17", "2025-07-23"], ["2025-07-24", "2025-07-30"]]); // derived, not calendar-guessed
  const dep = traffic[0].dependency;
  assert.equal(dep.mode, "staged");
  assert.equal(dep.dependsOn, "sales-movers:sales-latest-probe");
  assert.equal(dep.signalStatus, "success");
  assert.equal(dep.validated, true);
  assert.equal(dep.latestReportedDate, "2025-07-30");
  assert.ok(Object.isFrozen(dep));
});

test("Sales Movers — success-with-no-date / failed / terminal / unvalidated / last-known-good plan NO downstream", () => {
  const nonActivating = [
    { status: "success", validated: true, latestReportedDate: null },       // succeeded, no reported day => honest unavailable snapshot
    { status: "failed", validated: false, latestReportedDate: null },        // failed
    { status: "terminal", validated: false, latestReportedDate: null },      // terminal
    { status: "success", validated: false, latestReportedDate: "2025-07-30" }, // unvalidated
    { status: "last-known-good", validated: true, latestReportedDate: "2025-07-30" }, // conservative: no new exports
  ];
  for (const sig of nonActivating) {
    const jobs = reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "k", ids: ["A1"], windowsByRequestKey: smProbeWin, dependencySignals: { "sales-movers:sales-latest-probe": sig } });
    assert.deepEqual(keysOf(jobs), ["sales-movers:sales-latest-probe"], JSON.stringify(sig) + " must not activate downstream");
  }
});

test("Sales Movers — malformed probe signal / missing required date fail closed (throw)", () => {
  const call = (sig) => reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "k", ids: ["A1"], windowsByRequestKey: smProbeWin, dependencySignals: { "sales-movers:sales-latest-probe": sig } });
  assert.throws(() => call({ status: "bogus", validated: true }), /Invalid staged signal status/);
  assert.throws(() => call({ status: "success", validated: true, latestReportedDate: "2025/07/30" }), /YYYY-MM-DD/);
  assert.throws(() => call({ status: "success", validated: true }), /requires latestReportedDate/); // date field absent while required
});

/* ---- FIX 2: Listing Optimizer staged catalog state table ---- */

test("Listing Optimizer — kickoff plans ONLY SQP (catalog gated on it)", () => {
  const jobs = reportSourceRequestHashes({ reportKey: "listing-optimizer", apiKey: "k", ids: ["A1"], windowsByRequestKey: optSqpWin });
  assert.deepEqual(keysOf(jobs), ["listing-optimizer:sqp-weekly"]);
});

test("Listing Optimizer — validated SQP success (including a ZERO-row success) activates the catalog", () => {
  for (const sig of [{ status: "success", validated: true }, { status: "success", validated: true, latestReportedDate: null }]) {
    const jobs = reportSourceRequestHashes({ reportKey: "listing-optimizer", apiKey: "k", ids: ["A1"], windowsByRequestKey: optWin, dependencySignals: { "listing-optimizer:sqp-weekly": sig } });
    assert.deepEqual(keysOf(jobs), ["listing-optimizer:catalog", "listing-optimizer:sqp-weekly"]);
  }
});

test("Listing Optimizer — disabled/failed/unvalidated/last-known-good SQP does NOT consume a catalog export", () => {
  for (const sig of [
    { status: "terminal", validated: false }, // disabled SQP => sqpAvailable:false snapshot, catalog NOT scheduled
    { status: "failed", validated: false },
    { status: "success", validated: false },  // unvalidated
    { status: "last-known-good", validated: true }, // conservative
  ]) {
    const jobs = reportSourceRequestHashes({ reportKey: "listing-optimizer", apiKey: "k", ids: ["A1"], windowsByRequestKey: optSqpWin, dependencySignals: { "listing-optimizer:sqp-weekly": sig } });
    assert.deepEqual(keysOf(jobs), ["listing-optimizer:sqp-weekly"], JSON.stringify(sig) + " must not schedule catalog");
    assert.ok(!jobs.some((j) => j.requestKey === "listing-optimizer:catalog"), "no wasted catalog export");
  }
});

test("Listing Optimizer — a malformed SQP signal fails closed", () => {
  assert.throws(() => reportSourceRequestHashes({ reportKey: "listing-optimizer", apiKey: "k", ids: ["A1"], windowsByRequestKey: optSqpWin, dependencySignals: { "listing-optimizer:sqp-weekly": { status: "success" } } }), /validated must be a boolean/);
});

/* ---- FIX 3: PPC currency gate + failure policy state table ---- */

test("PPC — a single VALID Ads currency activates total-sales; empty/invalid/multiple skip it; catalog stays active regardless", () => {
  // Mirrors planPpcPerformance: the oli window is offered ONLY when the gate passes (state "single-valid").
  // Offering it for a gated-out state is itself a resolver error, so a fail-closed state plans catalog only.
  const plan = (state, currencyCount) => keysOf(reportSourceRequestHashes({
    reportKey: "ppc-performance", apiKey: "k", ids: ["A1"],
    windowsByRequestKey: state === "single-valid" ? ppcWin : ppcCatOnly,
    dependencySignals: { "ppc-performance:ads-currency": { status: "success", validated: true, currencyCount, state } },
  }));
  assert.deepEqual(plan("single-valid", 1), ["ppc-performance:catalog", "ppc-performance:oli-sales"]);
  assert.deepEqual(plan("empty", 0), ["ppc-performance:catalog"]); // empty: no ads currency to match => TACoS unavailable
  assert.deepEqual(plan("invalid", 1), ["ppc-performance:catalog"]); // a blank/malformed Ads row => fail closed
  assert.deepEqual(plan("multiple", 2), ["ppc-performance:catalog"]); // multi-currency: TACoS unavailable by design; catalog still enriches ASINs
});

test("PPC — missing/unvalidated currency signal skips total-sales (fail closed); malformed throws; catalog always stays", () => {
  assert.deepEqual(keysOf(reportSourceRequestHashes({ reportKey: "ppc-performance", apiKey: "k", ids: ["A1"], windowsByRequestKey: ppcCatOnly })), ["ppc-performance:catalog"]); // missing
  assert.deepEqual(keysOf(reportSourceRequestHashes({ reportKey: "ppc-performance", apiKey: "k", ids: ["A1"], windowsByRequestKey: ppcCatOnly, dependencySignals: { "ppc-performance:ads-currency": { status: "success", validated: false, currencyCount: 1, state: "single-valid" } } })), ["ppc-performance:catalog"]); // unvalidated
  assert.throws(() => reportSourceRequestHashes({ reportKey: "ppc-performance", apiKey: "k", ids: ["A1"], windowsByRequestKey: ppcCatOnly, dependencySignals: { "ppc-performance:ads-currency": { status: "success", validated: true, currencyCount: -1 } } }), /currencyCount/); // malformed
});

test("PPC total-sales carries an immutable failurePolicy (degrade, blocks:false, never partial); catalog has none", () => {
  const jobs = reportSourceRequestHashes({ reportKey: "ppc-performance", apiKey: "k", ids: ["A1"], windowsByRequestKey: ppcWin, dependencySignals: PPC_CUR_OK });
  const ts = jobs.find((j) => j.requestKey === "ppc-performance:oli-sales");
  const cat = jobs.find((j) => j.requestKey === "ppc-performance:catalog");
  assert.equal(ts.strict, true); // strict row cap...
  assert.equal(ts.failurePolicy.onFailure, "degrade");
  assert.equal(ts.failurePolicy.blocks, false);      // ...yet a cap failure degrades TACoS, never blocks PPC
  assert.equal(ts.failurePolicy.neverPartial, true); // capped/partial sales are a failure, never saved
  assert.equal(ts.failurePolicy.degradedScope, "tacos-denominator");
  assert.equal(cat.failurePolicy, null);             // catalog is independently required
  assert.equal(cat.dependency, null);                // and ungated
  const before = JSON.stringify(REPORT_SOURCE_CONTRACTS["ppc-performance"]);
  try { ts.failurePolicy.blocks = true; } catch (e) { /* frozen */ }
  assert.equal(ts.failurePolicy.blocks, false);
  assert.equal(JSON.stringify(REPORT_SOURCE_CONTRACTS["ppc-performance"]), before); // registry unchanged
});

test("PPC total-sales failurePolicy + dependency are execution metadata: request_hash is unchanged", () => {
  const ts = reportSourceRequestHashes({ reportKey: "ppc-performance", apiKey: "k", ids: ["A1"], windowsByRequestKey: ppcWin, dependencySignals: PPC_CUR_OK })
    .find((j) => j.requestKey === "ppc-performance:oli-sales");
  const expected = sourceRequestIdentity({
    apiKey: "k", sourceId: ts.sourceId, columns: byKey(REPORT_SOURCE_CONTRACTS["ppc-performance"], "ppc-performance:oli-sales").columns,
    ids: ts.sellerOrVendorIds, from: ts.from, to: ts.to, limit: ts.limit, options: ts.options,
  }).requestHash;
  assert.equal(ts.requestHash, expected); // identity ignores failurePolicy + dependency
});

/* ============ staged-policy re-review: window binding + strict dates + safeCode ============ */

// ---- FIX 2: strict UTC calendar-date validation ----
test("isValidCalendarDate accepts real days (incl. leap 2024-02-29) and rejects impossible dates", () => {
  for (const good of ["2024-02-29", "2025-07-30", "2000-02-29", "2025-12-31", "0099-06-15"]) {
    assert.equal(isValidCalendarDate(good), true, good + " should be valid");
  }
  for (const bad of ["2025-99-99", "2025-02-30", "0000-00-00", "2023-02-29", "2100-02-29", "2025-13-01", "2025-00-10", "2025-06-31", "2025-1-1", "2025/07/30", "20250730", "", null, undefined, 20250730]) {
    assert.equal(isValidCalendarDate(bad), false, JSON.stringify(bad) + " should be rejected");
  }
});

test("staged signal rejects an impossible latestReportedDate but keeps a valid leap day / null", () => {
  assert.equal(validateStagedSignal({ status: "success", validated: true, latestReportedDate: "2024-02-29" }).latestReportedDate, "2024-02-29");
  assert.equal(validateStagedSignal({ status: "success", validated: true, latestReportedDate: null }).latestReportedDate, null);
  for (const bad of ["2025-02-30", "2025-99-99", "0000-00-00", "2023-02-29"]) {
    assert.throws(() => validateStagedSignal({ status: "success", validated: true, latestReportedDate: bad }), /calendar date/, bad);
  }
});

test("salesMoversWindows rejects impossible dates and accepts a leap day", () => {
  assert.deepEqual(salesMoversWindows("2024-02-29"), { recent: { from: "2024-02-23", to: "2024-02-29" }, prior: { from: "2024-02-16", to: "2024-02-22" } });
  for (const bad of ["2025-02-30", "2025-99-99", "0000-00-00", "2023-02-29"]) {
    assert.throws(() => salesMoversWindows(bad), /calendar date/, bad);
  }
});

// ---- FIX 1: Sales Movers window binding to the validated probe date ----
const smProbeOnly = { "sales-movers:sales-latest-probe": [{ from: "2025-07-12", to: "2025-08-06" }] };
const smDownstreamWin = (date) => {
  const w = salesMoversWindows(date);
  return {
    "sales-movers:sales-latest-probe": [{ from: "2025-07-12", to: "2025-08-06" }],
    "sales-movers:traffic": [w.recent, w.prior],
    "sales-movers:ads": [w.recent, w.prior],
    "sales-movers:inventory": [{ from: "2025-07-27", to: "2025-08-06" }],
    "sales-movers:catalog": [{ from: null, to: null }],
  };
};
const smSig = (date) => ({ "sales-movers:sales-latest-probe": { status: "success", validated: true, latestReportedDate: date } });
const smResolve = (win, date) => reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "k", ids: ["A1"], windowsByRequestKey: win, dependencySignals: smSig(date) });

test("Sales Movers — the correct derived windows resolve, and request_hash is unchanged for them", () => {
  const jobs = smResolve(smDownstreamWin("2025-07-30"), "2025-07-30");
  const traffic = jobs.filter((j) => j.requestKey === "sales-movers:traffic");
  assert.deepEqual(traffic.map((j) => [j.from, j.to]), [["2025-07-24", "2025-07-30"], ["2025-07-17", "2025-07-23"]]);
  // identical to computing the identity directly => request_hash unchanged for valid requests
  const c = byKey(REPORT_SOURCE_CONTRACTS["sales-movers"], "sales-movers:traffic");
  const expected = sourceRequestIdentity({ apiKey: "k", sourceId: traffic[0].sourceId, columns: c.columns, ids: ["A1"], from: "2025-07-24", to: "2025-07-30", limit: c.limit, options: traffic[0].options }).requestHash;
  assert.equal(traffic[0].requestHash, expected);
});

test("Sales Movers — arbitrary traffic/ads windows (e.g. 1999-01-01..07) are REJECTED for a 2025-07-30 probe", () => {
  const w = salesMoversWindows("2025-07-30");
  const bogus = { from: "1999-01-01", to: "1999-01-07" };
  // arbitrary window
  const badArbitrary = { ...smDownstreamWin("2025-07-30"), "sales-movers:traffic": [bogus, w.prior] };
  assert.throws(() => smResolve(badArbitrary, "2025-07-30"), /must equal the recent/);
  // ads too
  const badAds = { ...smDownstreamWin("2025-07-30"), "sales-movers:ads": [w.recent, bogus] };
  assert.throws(() => smResolve(badAds, "2025-07-30"), /must equal the recent/);
});

test("Sales Movers — mismatched / missing / duplicated / extra / reordered windows all fail closed", () => {
  const w = salesMoversWindows("2025-07-30");
  const base = smDownstreamWin("2025-07-30");
  // duplicated (recent twice)
  assert.throws(() => smResolve({ ...base, "sales-movers:traffic": [w.recent, w.recent] }, "2025-07-30"), /must equal the recent/);
  // extra third window
  assert.throws(() => smResolve({ ...base, "sales-movers:traffic": [w.recent, w.prior, { from: "2025-07-01", to: "2025-07-07" }] }, "2025-07-30"), /must equal the recent/);
  // reordered (prior before recent) — order is bound, so rejected
  assert.throws(() => smResolve({ ...base, "sales-movers:traffic": [w.prior, w.recent] }, "2025-07-30"), /must equal the recent/);
  // only one window (missing prior)
  assert.throws(() => smResolve({ ...base, "sales-movers:traffic": [w.recent] }, "2025-07-30"), /must equal the recent/);
  // an off-by-one recent window
  assert.throws(() => smResolve({ ...base, "sales-movers:traffic": [{ from: "2025-07-23", to: "2025-07-29" }, w.prior] }, "2025-07-30"), /must equal the recent/);
});

test("Sales Movers — latestReportedDate must fall inside the actual probe window (boundaries inclusive)", () => {
  // probe window is 2025-07-12 .. 2025-08-06
  // equal to boundaries => allowed
  assert.equal(smResolve(smDownstreamWin("2025-07-12"), "2025-07-12").length, 7); // == from
  assert.equal(smResolve(smDownstreamWin("2025-08-06"), "2025-08-06").length, 7); // == to
  // before from / after to => rejected
  assert.throws(() => smResolve(smDownstreamWin("2025-07-11"), "2025-07-11"), /outside the probe window/);
  assert.throws(() => smResolve(smDownstreamWin("2025-08-07"), "2025-08-07"), /outside the probe window/);
});

test("Sales Movers — inventory as-of window and catalog no-date window are preserved (not bound)", () => {
  const jobs = smResolve(smDownstreamWin("2025-07-30"), "2025-07-30");
  const inv = jobs.find((j) => j.requestKey === "sales-movers:inventory");
  const cat = jobs.find((j) => j.requestKey === "sales-movers:catalog");
  assert.deepEqual([inv.from, inv.to], ["2025-07-27", "2025-08-06"]); // as-of preserved
  assert.deepEqual([cat.from, cat.to], [null, null]);                  // no-date preserved
});

test("Sales Movers — kickoff (probe only) is untouched by the window binding", () => {
  const jobs = reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "k", ids: ["A1"], windowsByRequestKey: smProbeOnly });
  assert.deepEqual([...new Set(jobs.map((j) => j.requestKey))], ["sales-movers:sales-latest-probe"]);
});

// ---- FIX 3: complete safeCode HTTP-status rejection ----
test("normalizeFailurePolicy rejects EVERY standalone 4xx/5xx safeCode; allows symbolic codes", () => {
  const make = (safeCode) => normalizeFailurePolicy({ onFailure: "degrade", degradedScope: "tacos-denominator", safeCode });
  for (const code of [400, 401, 402, 403, 404, 409, 422, 424, 429, 451, 499, 500, 502, 503, 599]) {
    assert.throws(() => make(`ERR_${code}`), /HTTP status/, String(code));
    assert.throws(() => make(String(code)), /HTTP status/, String(code));
  }
  // symbolic codes with no 3-digit 4xx/5xx run remain allowed
  for (const ok of ["TOTAL_SALES_UNAVAILABLE", "SOURCE_DISABLED", "TACOS_DENOMINATOR_MISSING", "CODE_200_OK_NOT_A_FAILURE", "BUCKET_12500"]) {
    const p = make(ok);
    assert.equal(p.safeCode, ok);
    assert.equal(p.blocks, false);
  }
});

console.log("\n" + passed + " assertions passed");
