import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  REPORT_SOURCE_REQUIREMENTS,
  SOURCE_CONTRACTS,
  assertSourceSupports,
  sourceContractForId,
  sourceContractForKey,
  sourceRequirementsForReport,
  sourceSupports,
} from "../lib/server/source-contracts.js";
import { fetchExportRows } from "../lib/server/datadoe.js";
import { PRODUCT_CATALOG } from "../lib/server/reports/sources.js";
import {
  buildBrandSalesPayload,
  syncAccountBrandCatalog,
  syncBrandCatalogBatch,
  classifyCatalogError,
  nextCatalogBatch,
  usableCatalogBrands,
  validCatalogActionId,
  catalogSyncEligibleAccounts,
  mergeAccountDirectory,
  orchestrateBrandCatalogAction,
  pruneBrandCatalogActionRecords,
  BRAND_CATALOG_BATCH_SIZE,
  SAFE_CATALOG_CODES,
  CATALOG_SOURCE_UNAVAILABLE,
  CATALOG_EMPTY,
  CATALOG_TRUNCATED,
  CATALOG_FETCH_FAILED,
  CATALOG_ATTEMPT_PENDING,
  BRAND_DIRECTORY_ACTION_CONFLICT,
  BRAND_DIRECTORY_ACTION_UNAVAILABLE,
} from "../api/datadoe.js";
import { mergeDiscoveredDataDoeAccounts, resolveDataDoeAccountIds } from "../lib/server/datadoe-connections.js";

// The live primary DataDoe Export Source ID for Product Catalog by ASIN, and the
// obsolete long id that now returns DataDoe "404 Source not found".
const PRODUCT_CATALOG_SHORT_ID = "68d2de238e";
const PRODUCT_CATALOG_OBSOLETE_LONG_ID = "68d2de238e8d1a47bc56a981a99d54558507b0bafb1e09f1b3e95fb7750a17a8";

// buildBrandSalesPayload scopes rows through the primary DataDoe connection, which needs
// a configured primary key. All DataDoe/Supabase traffic below is mocked; no key leaves
// the process. (The other tests use the transport's raw fetchExportRows and need none.)
process.env.DATADOE_API_KEY = process.env.DATADOE_API_KEY || "dd_api_test";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  not ok ${name}`);
    throw error;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  not ok ${name}`);
    throw error;
  }
}

console.log("Shared source contracts and export cache");

test("all source ids and aliases resolve to one canonical contract", () => {
  for (const item of SOURCE_CONTRACTS) {
    assert.equal(sourceContractForKey(item.key), item);
    for (const id of item.ids) assert.equal(sourceContractForId(id), item);
  }
});

test("every current report declares source or upstream snapshot requirements", () => {
  const expected = [
    "brand-sales", "daily-reporting", "reconciliation", "fba-plan", "sku-pl",
    "keyword-rank", "content-changes", "sales-movers", "listing-health",
    "listing-health-v3", // advanced Listing Health (shadow); OLI+catalog derived, listings/raw/inventory owned
    "buy-box-loss", "returns-leakage", "ppc-performance", "listing-optimizer",
    "brand-view", "priority-feed",
  ];
  for (const reportKey of expected) {
    assert.ok(sourceRequirementsForReport(reportKey)?.length, `${reportKey} has no declared dependency`);
  }
  assert.deepEqual(Object.keys(REPORT_SOURCE_REQUIREMENTS).sort(), expected.sort());
});

test("Order Line Items is valid for ordered units but not traffic/conversion", () => {
  assert.equal(sourceSupports("order-line-items", { grain: "order-item", fields: ["quantity", "item_price_value"] }), true);
  assert.equal(sourceSupports("order-line-items", { fields: ["session", "page_views"] }), false);
  assert.equal(sourceSupports("sales-traffic-asin-date", { grain: "asin-day", fields: ["session", "page_views", "total_units"] }), true);
  assert.throws(
    () => assertSourceSupports("order-line-items", { fields: ["session"] }),
    /cannot satisfy/
  );
});

test("inventory, advertising, profit and catalog remain distinct contracts", () => {
  assert.equal(sourceSupports("fba-inventory-health", { fields: ["available", "inbound_shipped"] }), true);
  assert.equal(sourceSupports("ads-asin-date", { fields: ["ad_spend", "ad_sales_same_sku"] }), true);
  assert.equal(sourceSupports("profit-by-sku-date", { fields: ["profit", "cogs_total"] }), true);
  assert.equal(sourceSupports("product-catalog", { fields: ["product_brand", "product_name"] }), true);
  assert.equal(sourceSupports("product-catalog", { fields: ["available"] }), false);
});

await asyncTest("migration keeps source payloads in private Storage with service-role-only metadata", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260806_shared_source_export_cache.sql", import.meta.url), "utf8");
  assert.match(sql, /create table if not exists public\.source_export_cache/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on table public\.source_export_cache from public, anon, authenticated/i);
  assert.match(sql, /prune_source_export_cache/i);
});

await asyncTest("identical concurrent and subsequent exports use one DataDoe request", async () => {
  const originalFetch = global.fetch;
  let creates = 0;
  let downloads = 0;
  const requests = new Map();
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/exports") && options.method === "POST") {
      creates += 1;
      const id = `export-${creates}`;
      requests.set(id, JSON.parse(options.body));
      return new Response(JSON.stringify({ id, status: "COMPLETED" }), { status: 200 });
    }
    const raw = target.match(/\/exports\/(export-\d+)\/raw$/);
    if (raw) {
      downloads += 1;
      const body = requests.get(raw[1]);
      return new Response(JSON.stringify({ rawContent: JSON.stringify([{ source: body.sourceId, marker: body.columns.join(",") }]) }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${target}`);
  };

  try {
    const args = [
      "dd_api_test", "401ffcd7e5", ["date", "child_asin"], ["account-1"],
      "2026-08-01", "2026-08-03", 50000,
      { groupBy: ["date", "child_asin"], orderByColumn: "date", orderByDirection: "ASC" },
    ];
    const [first, concurrent] = await Promise.all([
      fetchExportRows(...args),
      fetchExportRows(...args),
    ]);
    const later = await fetchExportRows(...args);
    assert.deepEqual(first, concurrent);
    assert.deepEqual(first, later);
    assert.equal(creates, 1);
    assert.equal(downloads, 1);

    // Full and short ids are aliases for the same canonical source, so the
    // second form safely reuses the first exact request.
    const fullAlias = await fetchExportRows(
      "dd_api_test", "401ffcd7e50c1ea9a18cacf221ddf99858db20a0f31eff65fc22a8e8140c7e1b",
      ["child_asin", "date"], ["account-1"], "2026-08-01", "2026-08-03", 50000,
      { groupBy: ["child_asin", "date"], orderByColumn: "date", orderByDirection: "ASC" }
    );
    assert.deepEqual(fullAlias, first);
    assert.equal(creates, 1);

    // A different field set is not compatible and must produce a new export.
    await fetchExportRows(
      "dd_api_test", "401ffcd7e5", ["date", "session"], ["account-1"],
      "2026-08-01", "2026-08-03", 50000,
      { groupBy: ["date"], orderByColumn: "date", orderByDirection: "ASC" }
    );
    assert.equal(creates, 2);

    // Explicit bypass is available for controlled correction jobs only.
    await fetchExportRows(...args.slice(0, 7), { ...args[7], bypassSourceCache: true });
    assert.equal(creates, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

/* ===================== Product Catalog live-source-id correction ===================== */

test("Product Catalog: the short live id and the obsolete long id resolve to ONE canonical contract", () => {
  const catalog = sourceContractForKey("product-catalog");
  assert.ok(catalog, "the product-catalog contract exists");
  assert.equal(sourceContractForId(PRODUCT_CATALOG_SHORT_ID), catalog, "the short live id resolves to product-catalog");
  assert.equal(sourceContractForId(PRODUCT_CATALOG_OBSOLETE_LONG_ID), catalog, "the obsolete long id resolves to the SAME contract (legacy alias)");
  assert.equal(catalog.ids[0], PRODUCT_CATALOG_SHORT_ID, "the short live id is the primary (request) id");
  assert.ok(catalog.ids.includes(PRODUCT_CATALOG_OBSOLETE_LONG_ID), "the long id remains registered as an alias for cache/identity stability");
  // Both live report registries carry the short id, never the obsolete one.
  assert.equal(PRODUCT_CATALOG.id, PRODUCT_CATALOG_SHORT_ID, "reports/sources.js Product Catalog uses the short live id");
});

await asyncTest("api/datadoe.js sends the SHORT live Product Catalog source id, never the obsolete long id", async () => {
  const src = await readFile(new URL("../api/datadoe.js", import.meta.url), "utf8");
  assert.match(src, /const PRODUCT_CATALOG_SOURCE_ID = "68d2de238e";/, "PRODUCT_CATALOG_SOURCE_ID is the short live id");
  assert.doesNotMatch(src, /PRODUCT_CATALOG_SOURCE_ID = "68d2de238e8d1a47bc56a981a99d54558507b0bafb1e09f1b3e95fb7750a17a8"/, "the obsolete long id is never assigned as the request id");
});

await asyncTest("request_hash is stable across the alias: the short id posts the export, the long id reuses it (obsolete id never sent)", async () => {
  const originalFetch = global.fetch;
  const posted = [];
  let creates = 0;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/exports") && options.method === "POST") {
      creates += 1;
      posted.push(JSON.parse(options.body).sourceId);
      return new Response(JSON.stringify({ id: `cat-${creates}`, status: "COMPLETED" }), { status: 200 });
    }
    if (/\/exports\/cat-\d+\/raw$/.test(target)) {
      return new Response(JSON.stringify({ rawContent: JSON.stringify([{ child_asin: "A1", product_brand: "Bebi Born" }]) }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${target}`);
  };
  try {
    const cols = ["child_asin", "product_brand"];
    const shortRows = await fetchExportRows("dd_api_test", PRODUCT_CATALOG_SHORT_ID, cols, ["cat-acct-1"], null, null, 10000, { orderByColumn: "child_asin" });
    const aliasRows = await fetchExportRows("dd_api_test", PRODUCT_CATALOG_OBSOLETE_LONG_ID, cols, ["cat-acct-1"], null, null, 10000, { orderByColumn: "child_asin" });
    assert.deepEqual(posted, [PRODUCT_CATALOG_SHORT_ID], "exactly one export was created, posting the SHORT live source id");
    assert.equal(creates, 1, "the long id reused the short id's export via the shared contract key; no second export, obsolete id never posted");
    assert.deepEqual(shortRows, aliasRows, "both aliases return the same rows from the one export");
  } finally {
    global.fetch = originalFetch;
  }
});

// Drive buildBrandSalesPayload with mocked DataDoe exports: the Order Line Items export
// returns real sales; the Product Catalog export returns whatever `catalogRows` gives.
// `n` distinguishes account ids so each call has a fresh request_hash (no cache reuse).
async function runBrandSales(catalogRows, n) {
  const originalFetch = global.fetch;
  const sourceByExport = new Map();
  const postedSourceIds = [];
  let creates = 0;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/exports") && options.method === "POST") {
      creates += 1;
      const id = `bs${n}-${creates}`;
      const sourceId = JSON.parse(options.body).sourceId;
      sourceByExport.set(id, sourceId);
      postedSourceIds.push(sourceId);
      return new Response(JSON.stringify({ id, status: "COMPLETED" }), { status: 200 });
    }
    const raw = target.match(new RegExp(`/exports/(bs${n}-\\d+)/raw$`));
    if (raw) {
      const rows = sourceByExport.get(raw[1]) === PRODUCT_CATALOG_SHORT_ID
        ? catalogRows
        : [{ date: "2026-08-01", child_asin: "A1", seller_or_vendor_id: "S1", seller_or_vendor_name: "Seller", marketplace_country_code: "US", item_price_currency: "USD", total_sales_sum: 100, total_units_sold_sum: 5 }];
      return new Response(JSON.stringify({ rawContent: JSON.stringify(rows) }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${target}`);
  };
  try {
    const result = await buildBrandSalesPayload({ apiKey: "dd_api_test", ids: [`req6-acct-${n}`], from: "2026-07-01", to: "2026-08-01" }).then(
      (payload) => ({ payload, postedSourceIds }),
      (error) => ({ error, postedSourceIds }),
    );
    return result;
  } finally {
    global.fetch = originalFetch;
  }
}

await asyncTest("a successful ZERO-ROW Product Catalog rejects buildBrandSalesPayload (LKG must not be overwritten)", async () => {
  const { payload, error, postedSourceIds } = await runBrandSales([], 1);
  assert.equal(payload, undefined, "no payload is returned");
  assert.ok(error && error.brandSalesUnavailable === true, "a typed, admin-safe unavailable error is thrown");
  assert.equal(error.message, "Product Catalog has no usable brand mappings yet. Previous saved Brand Sales data was preserved.");
  assert.doesNotMatch(error.message, /DataDoe|404|export|http/i, "no raw DataDoe detail is exposed");
  // The short live id was posted for the catalog; the obsolete id is never posted (no fallback).
  assert.ok(postedSourceIds.includes(PRODUCT_CATALOG_SHORT_ID), "the catalog export used the short live source id");
  assert.ok(!postedSourceIds.includes(PRODUCT_CATALOG_OBSOLETE_LONG_ID), "the obsolete long id is never posted, even after a zero-row result");
});

await asyncTest("a non-empty Catalog with NO usable child_asin -> product_brand mappings also rejects", async () => {
  // Rows exist but carry no usable ASIN+brand pair (blank asin, blank brand).
  const unusable = [
    { child_asin: "", product_brand: "Acme" },
    { child_asin: "A1", product_brand: "" },
    { child_asin: "   ", product_brand: "   " },
  ];
  const { payload, error } = await runBrandSales(unusable, 2);
  assert.equal(payload, undefined);
  assert.ok(error && error.brandSalesUnavailable === true, "an unusable-mapping catalog fails closed just like zero rows");
  assert.equal(error.message, "Product Catalog has no usable brand mappings yet. Previous saved Brand Sales data was preserved.");
});

await asyncTest("a valid Catalog with usable brand mappings still builds normally", async () => {
  const { payload, error } = await runBrandSales([{ child_asin: "A1", product_brand: "Bebi Born" }], 3);
  assert.equal(error, undefined, "a usable catalog does not reject");
  assert.deepEqual(payload.asinBrand, { A1: "Bebi Born" }, "the ASIN->brand map is populated");
  assert.deepEqual(payload.catalogBrands, ["Bebi Born"], "the brand list is derived from the mapped sales");
  assert.equal(payload.rows[0].total_sales, 100, "real order sales are preserved for the saved snapshot");
  assert.equal(payload.rows[0].product_brand, "Bebi Born", "the mapped brand is attributed");
});

/* ===================== Brand Directory catalog retry queue ===================== */

// A tiny in-memory catalog store so the LKG/typed-code/atomic-claim policy is exercised
// end to end without Supabase. It models TWO durable stores plus the claim lock:
//   - `byAccount`: the brand-catalog LKG snapshot (getPriorSnapshot/saveSnapshot);
//   - `attempts`: the SEPARATE per-(action,account) attempt row (getAttemptState/
//     saveAttemptState), scoped by `${actionId}::${accountId}`;
//   - `locks`: the atomic claim. claimAttempt's has/add pair runs synchronously before
//     its promise resolves, so in a single-threaded test exactly one of two concurrent
//     same-(action,account) claims wins -- modelling claim_report_refresh_lock's atomicity.
function makeCatalogStore(seed = {}) {
  const byAccount = new Map(Object.entries(seed));
  const attempts = new Map();
  const locks = new Set();
  const saves = [];
  const attemptSaves = [];
  const key = (accountId, actionId) => `${actionId}::${accountId}`;
  return {
    saves,
    attemptSaves,
    getPriorSnapshot: (accountId) => Promise.resolve(byAccount.get(String(accountId)) || null),
    saveSnapshot: (accountId, payload) => { saves.push({ accountId: String(accountId), payload }); byAccount.set(String(accountId), { payload }); return Promise.resolve(); },
    claimAttempt: (accountId, actionId) => { const k = key(accountId, actionId); if (locks.has(k)) return Promise.resolve(false); locks.add(k); return Promise.resolve(true); },
    releaseAttempt: (accountId, actionId) => { locks.delete(key(accountId, actionId)); return Promise.resolve(); },
    getAttemptState: (accountId, actionId) => Promise.resolve(attempts.get(key(accountId, actionId)) || null),
    saveAttemptState: (accountId, actionId, state) => { const payload = { ...state, accountId: String(accountId), actionId }; attemptSaves.push(payload); attempts.set(key(accountId, actionId), payload); return Promise.resolve(); },
    snapshot: (accountId) => byAccount.get(String(accountId)) || null,
    attempt: (accountId, actionId) => attempts.get(key(accountId, actionId)) || null,
    lockHeld: (accountId, actionId) => locks.has(key(accountId, actionId)),
  };
}
const PRIMARY = { id: "primary", apiKey: "dd_api_test" };
const acct = (id) => ({ accountId: id, rawAccountId: id, connection: PRIMARY });

await asyncTest("retry queue: ONE explicit refresh attempts every eligible account (14 old-long-id + 1) exactly once and terminates", async () => {
  const eligible = Array.from({ length: 15 }, (_, i) => `A${String(i + 1).padStart(2, "0")}`);
  const attempts = [];
  let requests = 0;
  let cursor = eligible;
  let batchSizes = [];
  // Simulate the server cursor + browser continuation loop end to end.
  while (cursor.length && requests < 40) {
    const { batch, remainingAccountIds } = nextCatalogBatch(cursor, BRAND_CATALOG_BATCH_SIZE);
    batchSizes.push(batch.length);
    await syncBrandCatalogBatch(batch, [PRIMARY], {
      attemptAccount: (id) => { attempts.push(id); return { accountId: id, status: "unavailable", code: CATALOG_SOURCE_UNAVAILABLE }; },
    });
    cursor = remainingAccountIds;
    requests += 1;
  }
  assert.equal(attempts.length, 15, "exactly 15 attempts total -- not 40, not an infinite loop");
  assert.deepEqual([...new Set(attempts)].sort(), eligible.slice().sort(), "every eligible account was attempted");
  attempts.forEach((id, i) => assert.equal(attempts.indexOf(id), i, `${id} was attempted only once`));
  assert.equal(requests, 15, "one export per request => 15 requests for 15 accounts");
  assert.ok(batchSizes.every((n) => n === 1), "each request processes EXACTLY ONE export (deadline-safe)");
  // The 14 previously-failed (old long id) accounts are all attempted, never starved.
  eligible.slice(0, 14).forEach((id) => assert.ok(attempts.includes(id), `${id} (old-long-id error) was retried`));
});

await asyncTest("blocker 1: one export per invocation -- a slow export cannot consume the next cursor item", async () => {
  const cursor = ["A1", "A2", "A3"];
  const { batch, remainingAccountIds } = nextCatalogBatch(cursor, BRAND_CATALOG_BATCH_SIZE);
  assert.deepEqual(batch, ["A1"], "exactly one account is attempted this request");
  assert.deepEqual(remainingAccountIds, ["A2", "A3"], "the next cursor items are untouched");
  const store = makeCatalogStore();
  const fetched = [];
  await syncBrandCatalogBatch(batch, [PRIMARY], {
    ...store, actionId: "SLOW1",
    // Simulate a SLOW export: even if this took ~45s, only A1 is touched this invocation.
    fetchCatalog: ({ rawAccountId }) => { fetched.push(rawAccountId); return [{ child_asin: "X", product_brand: "Acme" }]; },
  });
  assert.deepEqual(fetched, ["A1"], "the slow export touched only A1; A2/A3 were never fetched this request");
});

await asyncTest("blocker 1: two concurrent same-action requests create EXACTLY ONE export (atomic claim before create-export)", async () => {
  const store = makeCatalogStore();
  let fetchCalls = 0;
  const run = () => syncAccountBrandCatalog({ ...acct("A1"), actionId: "ACT1" }, {
    ...store, fetchCatalog: () => { fetchCalls += 1; return [{ child_asin: "A1", product_brand: "Bebi Born" }]; },
  });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(fetchCalls, 1, "two concurrent same-(action,account) requests created exactly ONE DataDoe export");
  assert.ok([a, b].some((r) => r.status === "complete" && !r.skipped), "one request won the claim and completed the export");
  const loser = [a, b].find((r) => r.skipped);
  assert.ok(loser, "the other request lost the claim and is a no-op (skipped) -- it created NO export");
  assert.equal(store.snapshot("A1").payload.catalogSyncStatus, "complete", "the single successful export is saved once");
  assert.equal(store.lockHeld("A1", "ACT1"), false, "the short-lived claim is released after the invocation");
});

await asyncTest("blocker 1: a claim-write failure (throw or refusal) creates ZERO exports (fail closed)", async () => {
  for (const claimAttempt of [() => Promise.reject(new Error("lock backend unavailable")), () => Promise.resolve(false)]) {
    const store = makeCatalogStore();
    let fetchCalls = 0;
    const result = await syncAccountBrandCatalog({ ...acct("A1"), actionId: "ACT1" }, {
      ...store, claimAttempt, fetchCatalog: () => { fetchCalls += 1; return [{ child_asin: "A1", product_brand: "Bebi Born" }]; },
    });
    assert.equal(fetchCalls, 0, "no export was created when the claim could not be taken");
    assert.equal(result.skipped, true, "the request is an admin-safe no-op");
    assert.equal(result.status, "attempting");
    assert.equal(result.code, CATALOG_ATTEMPT_PENDING, "typed attempting/unknown code -- waits for a new explicit action");
    assert.equal(store.snapshot("A1"), null, "no brand-catalog snapshot was written");
    assert.equal(store.attempt("A1", "ACT1"), null, "no durable attempt marker was written");
  }
});

await asyncTest("blocker 3: a missing / malformed / changed action id creates ZERO exports (fail closed at the sync layer)", async () => {
  // validCatalogActionId is the single gate the handler applies BEFORE any DataDoe call.
  assert.equal(validCatalogActionId(""), null, "missing id rejected");
  assert.equal(validCatalogActionId(null), null, "null id rejected");
  assert.equal(validCatalogActionId("bad id!"), null, "malformed id (space/punctuation) rejected");
  assert.equal(validCatalogActionId("x".repeat(65)), null, "oversized id rejected");
  assert.equal(validCatalogActionId("ACT-1_ok"), "ACT-1_ok", "a safe token shape is accepted verbatim");
  // A rejected id resolves to null, and the sync fails closed without an export.
  for (const bad of ["", null, undefined, "bad id!", "x".repeat(65)]) {
    const store = makeCatalogStore();
    let fetchCalls = 0;
    const result = await syncAccountBrandCatalog({ ...acct("A1"), actionId: validCatalogActionId(bad) }, {
      ...store, fetchCatalog: () => { fetchCalls += 1; return [{ child_asin: "A1", product_brand: "Bebi Born" }]; },
    });
    assert.equal(fetchCalls, 0, `no export for unusable action id ${JSON.stringify(bad)}`);
    assert.equal(result.skipped, true);
    assert.equal(store.snapshot("A1"), null, "nothing was written without a valid action id");
  }
});

test("classifyCatalogError maps to typed codes and never returns a raw body", () => {
  assert.equal(classifyCatalogError(new Error(`DataDoe export creation failed (404): {"message":"Source not found","statusCode":404}`)), CATALOG_SOURCE_UNAVAILABLE);
  assert.equal(classifyCatalogError(new Error("Product Catalog reached the 10,000 row cap and was not used.")), CATALOG_TRUNCATED);
  assert.equal(classifyCatalogError(new Error("DataDoe export timed out while processing.")), CATALOG_FETCH_FAILED);
  assert.equal(classifyCatalogError(new Error("boom")), CATALOG_FETCH_FAILED);
  for (const code of [CATALOG_SOURCE_UNAVAILABLE, CATALOG_TRUNCATED, CATALOG_FETCH_FAILED]) assert.ok(SAFE_CATALOG_CODES.has(code));
});

await asyncTest("catalog sync posts ONLY the short live source id and returns a typed code (no raw DataDoe body/source id/url)", async () => {
  const store = makeCatalogStore();
  let postedSourceId = null;
  const result = await syncAccountBrandCatalog({ ...acct("A1"), actionId: "ACT1" }, {
    ...store,
    fetchCatalog: ({ sourceId }) => { postedSourceId = sourceId; const e = new Error(`DataDoe export creation failed (404): {"message":"Source not found"} https://api.datadoe.com/api/v1/exports`); throw e; },
  });
  assert.equal(postedSourceId, PRODUCT_CATALOG_SHORT_ID, "the code sends the SHORT live source id to the fetcher");
  assert.notEqual(postedSourceId, PRODUCT_CATALOG_OBSOLETE_LONG_ID, "never the obsolete long id");
  assert.equal(result.status, "unavailable");
  assert.equal(result.code, CATALOG_SOURCE_UNAVAILABLE, "a 404 is the typed source-unavailable code");
  // Neither the return value nor the persisted payload carries a raw DataDoe body/url/source id.
  const blob = JSON.stringify([result, store.snapshot("A1")]);
  assert.doesNotMatch(blob, /Source not found|statusCode|https?:\/\/|api\/v1|68d2de238e8d1a/i, "no raw DataDoe detail is persisted or returned");
  assert.equal(store.snapshot("A1").payload.catalogSyncCode, CATALOG_SOURCE_UNAVAILABLE);
  assert.equal(store.snapshot("A1").payload.catalogSyncError, undefined, "the raw-error field is gone");
});

await asyncTest("blocker 4/5: a failed refresh leaves the successful LKG snapshot BYTE-IDENTICAL and records the failure in a SEPARATE per-action row", async () => {
  // A real getLatestReportSnapshot returns source_refreshed_at alongside payload; model it
  // so the test can prove the successful source freshness never advances on a failed refresh.
  const good = { source_refreshed_at: "2026-08-10T00:00:00.000Z", payload: { catalogBrands: ["Bebi Born", "Nordfell"], catalogSyncStatus: "complete", catalogSyncedAt: "2026-08-10T00:00:00.000Z" } };
  const goodBytes = JSON.stringify(good);
  const failures = [
    { label: "404", code: CATALOG_SOURCE_UNAVAILABLE, fetchCatalog: () => { throw new Error("DataDoe export creation failed (404): Source not found"); } },
    { label: "timeout", code: CATALOG_FETCH_FAILED, fetchCatalog: () => { throw new Error("DataDoe export timed out while processing."); } },
    { label: "truncation", code: CATALOG_TRUNCATED, fetchCatalog: () => new Array(10000).fill({ child_asin: "A", product_brand: "B" }) },
    { label: "empty", code: CATALOG_EMPTY, fetchCatalog: () => [] },
    { label: "unusable", code: CATALOG_EMPTY, fetchCatalog: () => [{ child_asin: "", product_brand: "" }, { child_asin: "A", product_brand: "" }] },
  ];
  for (const f of failures) {
    const store = makeCatalogStore({ A1: good });
    const result = await syncAccountBrandCatalog({ ...acct("A1"), actionId: "ACT1" }, { ...store, fetchCatalog: f.fetchCatalog });
    assert.equal(result.status, "unavailable", `${f.label}: reported unavailable`);
    assert.equal(result.preservedLkg, true, `${f.label}: last-known-good is preserved`);
    assert.equal(result.code, f.code, `${f.label}: the typed code is returned`);
    // Blocker 4: the successful brand-catalog snapshot was NOT rewritten at all -- neither
    // its brand map NOR its source_refreshed_at moved. It is byte-for-byte the prior value.
    assert.equal(store.saves.filter((s) => s.accountId === "A1").length, 0, `${f.label}: the LKG snapshot was never written on a failed refresh`);
    assert.equal(JSON.stringify(store.snapshot("A1")), goodBytes, `${f.label}: LKG payload + source_refreshed_at are byte-identical`);
    // The typed failure lives in the SEPARATE per-(action,account) attempt row (blocker 5).
    const attempt = store.attempt("A1", "ACT1");
    assert.equal(attempt.status, "unavailable", `${f.label}: the attempt row records the failure`);
    assert.ok(SAFE_CATALOG_CODES.has(attempt.code), `${f.label}: typed attempt code recorded`);
    assert.equal(attempt.preservedLkg, true, `${f.label}: the attempt row notes the LKG was preserved`);
    // No raw DataDoe body/url/status anywhere in the returned or persisted state.
    const blob = JSON.stringify([result, store.snapshot("A1"), attempt]);
    assert.doesNotMatch(blob, /Source not found|statusCode|https?:\/\/|api\/v1/i, `${f.label}: no raw DataDoe detail persisted or returned`);
  }
});

test("blocker 3: a row with a blank ASIN and a named brand is NOT usable coverage (PRODUCT_CATALOG_EMPTY)", () => {
  assert.deepEqual(usableCatalogBrands([{ child_asin: "", product_brand: "Bebi Born" }]), [], "blank ASIN + named brand => no usable mapping");
  assert.deepEqual(usableCatalogBrands([{ child_asin: "A1", product_brand: "" }]), [], "named ASIN + blank brand => no usable mapping");
  assert.deepEqual(usableCatalogBrands([{ child_asin: "A1", product_brand: "Unassigned" }]), [], "Unassigned is never a real brand");
  assert.deepEqual(usableCatalogBrands([{ child_asin: "A1", product_brand: "Bebi Born" }, { child_asin: "", product_brand: "Ghost" }]), ["Bebi Born"], "only the usable row contributes");
});

await asyncTest("blocker 3 end to end: a blank-ASIN/named-brand catalog yields PRODUCT_CATALOG_EMPTY and never saves complete coverage", async () => {
  const store = makeCatalogStore();
  const result = await syncAccountBrandCatalog({ ...acct("A1"), actionId: "ACT1" }, {
    ...store, fetchCatalog: () => [{ child_asin: "", product_brand: "Bebi Born" }],
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.code, CATALOG_EMPTY, "no usable child_asin -> product_brand mapping is PRODUCT_CATALOG_EMPTY");
  assert.equal(store.snapshot("A1").payload.catalogSyncStatus, "unavailable", "complete coverage is never saved");
  assert.deepEqual(store.snapshot("A1").payload.catalogBrands, [], "no fabricated brand is saved");
});

await asyncTest("blocker 4: replaying a continuation under the same action id spends ZERO duplicate exports", async () => {
  const store = makeCatalogStore();
  let fetchCalls = 0;
  const attempt = () => syncAccountBrandCatalog({ ...acct("A1"), actionId: "ACT1" }, {
    ...store, fetchCatalog: () => { fetchCalls += 1; return [{ child_asin: "A1", product_brand: "Bebi Born" }]; },
  });
  const first = await attempt();
  const replay = await attempt(); // identical continuation replay under the SAME action id
  const replay2 = await attempt();
  assert.equal(fetchCalls, 1, "exactly ONE export was spent; the replays created NO new export");
  assert.equal(first.status, "complete");
  assert.equal(replay.skipped, true, "the replay is a no-op that returns the recorded outcome");
  assert.equal(replay.status, "complete");
  assert.equal(replay2.skipped, true);
  // A genuinely NEW action (different id) re-attempts (one more export) -- that is a new user action, not a replay.
  const newAction = await syncAccountBrandCatalog({ ...acct("A1"), actionId: "ACT2" }, {
    ...store, fetchCatalog: () => { fetchCalls += 1; return [{ child_asin: "A1", product_brand: "Bebi Born" }]; },
  });
  assert.equal(newAction.skipped, undefined, "a new action id is not a replay");
  assert.equal(fetchCalls, 2, "a new action spends exactly one more export");
});

await asyncTest("blocker 2: an early-batch failure that PRESERVES LKG still appears in the final cumulative summary after later batches", async () => {
  // Mirror the handler's summary predicate: an account is a this-action failure if the main
  // snapshot has no usable saved catalog, OR its SEPARATE per-action attempt row did not
  // succeed (whether its brand map is a preserved LKG or absent). Reading from the per-action
  // row is what keeps overlapping actions isolated and stops a re-read from dropping failures.
  const summaryFor = (store, ids, actionId) => ids.filter((id) => {
    if (store.snapshot(id)?.payload?.catalogSyncStatus === "unavailable") return true; // no usable saved catalog
    const attempt = store.attempt(id, actionId);
    return Boolean(attempt) && attempt.status !== "complete"; // this-action failure (LKG preserved or attempting)
  });
  const store = makeCatalogStore({ A1: { payload: { catalogBrands: ["Bebi Born"], catalogSyncStatus: "complete", catalogSyncedAt: "2026-08-10T00:00:00.000Z" } } });
  // Batch 1: A1 (has LKG) fails 404 -> LKG preserved, failure recorded in the attempt row.
  await syncAccountBrandCatalog({ ...acct("A1"), actionId: "ACT1" }, { ...store, fetchCatalog: () => { throw new Error("DataDoe export creation failed (404): Source not found"); } });
  assert.deepEqual(summaryFor(store, ["A1", "A2"], "ACT1"), ["A1"], "A1's failure is in the summary after batch 1");
  // Batch 2: A2 succeeds. Re-reading A1's (still complete) snapshot must NOT drop A1's earlier failure.
  await syncAccountBrandCatalog({ ...acct("A2"), actionId: "ACT1" }, { ...store, fetchCatalog: () => [{ child_asin: "A2x", product_brand: "Nordfell" }] });
  assert.equal(store.snapshot("A1").payload.catalogSyncStatus, "complete", "A1's LKG map is still readable");
  assert.deepEqual(summaryFor(store, ["A1", "A2"], "ACT1"), ["A1"], "A1's early-batch LKG-preserved failure STILL appears in the final summary");
});

await asyncTest("blocker 2: an outcome-write failure leaves the durable 'attempting' marker; a replay creates ZERO further exports", async () => {
  const store = makeCatalogStore();
  const realSave = store.saveAttemptState;
  let fetchCalls = 0;
  // The pre-export 'attempting' marker persists, but the TERMINAL outcome write fails.
  const failingOutcome = {
    ...store,
    saveAttemptState: (accountId, actionId, state) => (state.status === "attempting"
      ? realSave(accountId, actionId, state)
      : Promise.reject(new Error("outcome persistence failed"))),
    fetchCatalog: () => { fetchCalls += 1; return [{ child_asin: "A1", product_brand: "Bebi Born" }]; },
  };
  const first = await syncAccountBrandCatalog({ ...acct("A1"), actionId: "ACT1" }, failingOutcome);
  assert.equal(fetchCalls, 1, "the first invocation created its one export");
  assert.equal(first.status, "complete", "the computed outcome is still returned to this request");
  assert.equal(store.attempt("A1", "ACT1").status, "attempting", "the durable marker stays 'attempting' because the terminal write failed");
  // Replay under the SAME action: the durable 'attempting' marker blocks a second export.
  const replay = await syncAccountBrandCatalog({ ...acct("A1"), actionId: "ACT1" }, {
    ...store, fetchCatalog: () => { fetchCalls += 1; return [{ child_asin: "A1", product_brand: "Bebi Born" }]; },
  });
  assert.equal(fetchCalls, 1, "the replay created NO additional export");
  assert.equal(replay.skipped, true, "the replay is an admin-safe no-op");
  assert.equal(replay.status, "attempting", "an unknown/attempting outcome waits for a NEW explicit action, never auto-retries");
});

await asyncTest("blocker 5: overlapping action ids keep SEPARATE typed failure summaries (scoped by action + account)", async () => {
  const store = makeCatalogStore();
  // ACT1 attempts A1 and hits a 404 source failure.
  await syncAccountBrandCatalog({ ...acct("A1"), actionId: "ACT1" }, { ...store, fetchCatalog: () => { throw new Error("DataDoe export creation failed (404): Source not found"); } });
  // ACT2 (a different, overlapping action) attempts the SAME account and hits a truncation.
  await syncAccountBrandCatalog({ ...acct("A1"), actionId: "ACT2" }, { ...store, fetchCatalog: () => new Array(10000).fill({ child_asin: "A", product_brand: "B" }) });
  const a1 = store.attempt("A1", "ACT1");
  const a2 = store.attempt("A1", "ACT2");
  assert.equal(a1.code, CATALOG_SOURCE_UNAVAILABLE, "ACT1 keeps its own 404 code");
  assert.equal(a2.code, CATALOG_TRUNCATED, "ACT2 records its own truncation code");
  assert.notEqual(a1.code, a2.code, "overlapping actions did NOT overwrite each other's typed summary");
});

await asyncTest("mixed outcome: a successful account updates its map; a failed account with no prior success saves a typed-unavailable marker (no fabricated brands)", async () => {
  const store = makeCatalogStore();
  const results = await syncBrandCatalogBatch(["GOOD", "BAD"], [PRIMARY], {
    ...store,
    actionId: "MIX1",
    fetchCatalog: ({ rawAccountId }) => (rawAccountId === "GOOD"
      ? [{ child_asin: "A1", product_brand: "Bebi Born" }]
      : (() => { throw new Error("DataDoe export creation failed (404): Source not found"); })()),
  });
  const good = results.find((r) => r.accountId === "GOOD");
  const bad = results.find((r) => r.accountId === "BAD");
  assert.equal(good.status, "complete");
  assert.deepEqual(store.snapshot("GOOD").payload.catalogBrands, ["Bebi Born"]);
  assert.equal(store.snapshot("GOOD").payload.catalogSyncStatus, "complete");
  assert.equal(bad.status, "unavailable");
  assert.equal(bad.code, CATALOG_SOURCE_UNAVAILABLE);
  assert.deepEqual(store.snapshot("BAD").payload.catalogBrands, [], "no fabricated brands for the failed account");
  assert.equal(store.snapshot("BAD").payload.catalogSyncStatus, "unavailable");
});

await asyncTest("primary-only: a dormant dd-secondary account is skipped read-only and never routed through the primary key", async () => {
  let attempted = [];
  const store = makeCatalogStore();
  const results = await syncBrandCatalogBatch(["A1", "dd-secondary:OLD", "A2"], [PRIMARY], {
    ...store,
    actionId: "PRIM1",
    fetchCatalog: ({ rawAccountId }) => { attempted.push(rawAccountId); return [{ child_asin: "X", product_brand: "Acme" }]; },
  });
  assert.deepEqual(attempted.sort(), ["A1", "A2"], "only primary accounts reached DataDoe; the dd-secondary id was skipped");
  assert.ok(!results.some((r) => String(r.accountId).startsWith("dd-secondary:")), "no dd-secondary result was produced");
});

/* ===================== Future account auto-discovery (blocker 6) ===================== */

const PRIMARY_CONN = { id: "primary", label: "Primary DataDoe", apiKey: "dd_api_test", accountPrefix: "" };
const SECONDARY_CONN = { id: "secondary", label: "Secondary DataDoe", apiKey: "dd_api_secondary", accountPrefix: "dd-secondary:" };
const DATADOE_SRC = await readFile(new URL("../api/datadoe.js", import.meta.url), "utf8");

await asyncTest("blocker 6: a newly added primary account appears purely from discovery (no code/config change)", async () => {
  // An account id that appears in NO source file: discovery is the only thing that surfaces it.
  const NOVEL = "acct-novel-93f2c7";
  assert.doesNotMatch(DATADOE_SRC, new RegExp(NOVEL), "the new account id is NOT hard-coded anywhere in the server");
  // Discovery merges it into the durable directory as active, with no manual mapping.
  const merged = mergeAccountDirectory([], [{ id: NOVEL, name: "Novel Co", country: "DE", currency: "EUR" }]);
  const entry = merged.find((a) => a.id === NOVEL);
  assert.ok(entry, "the discovered account is present in the directory");
  assert.equal(entry.active, true, "and it is active");
  assert.equal(entry.country, "DE", "its discovered country is carried with no source-code country list");
});

await asyncTest("blocker 6: a newly discovered primary account is appended to the current action and attempted EXACTLY once", async () => {
  const NEW = "NEW1";
  // A never-synced account is placed in pending by sharedSnapshotBrandAccounts; model that.
  const directory = { catalogPendingAccountIds: new Set([NEW]), catalogUnavailable: new Map() };
  assert.deepEqual(catalogSyncEligibleAccounts([NEW], directory), [NEW], "the new account is eligible for a one-time attempt");
  // Drive the one-export-per-request cursor loop end to end; the new account is exported once.
  const store = makeCatalogStore();
  const fetched = [];
  let cursor = catalogSyncEligibleAccounts([NEW], directory);
  let requests = 0;
  while (cursor.length && requests < 10) {
    const { batch, remainingAccountIds } = nextCatalogBatch(cursor, BRAND_CATALOG_BATCH_SIZE);
    await syncBrandCatalogBatch(batch, [PRIMARY], {
      ...store, actionId: "DISC1",
      fetchCatalog: ({ rawAccountId }) => { fetched.push(rawAccountId); return [{ child_asin: "A1", product_brand: "NewBrand" }]; },
    });
    cursor = remainingAccountIds;
    requests += 1;
  }
  assert.deepEqual(fetched, [NEW], "the new account was attempted exactly once");
  assert.equal(store.snapshot(NEW).payload.catalogSyncStatus, "complete", "its catalog result is saved");
});

test("blocker 6: an already-complete account is never attempted again (not in the eligible set)", () => {
  // COMPLETE1 has a saved complete snapshot, so sharedSnapshotBrandAccounts never lists it in
  // pending/unavailable; only the pending new account is eligible.
  const directory = { catalogPendingAccountIds: new Set(["NEW1"]), catalogUnavailable: new Map() };
  assert.deepEqual(catalogSyncEligibleAccounts(["NEW1", "COMPLETE1"], directory), ["NEW1"], "a complete account is not scheduled a second time");
});

await asyncTest("blocker 6: a removed account preserves its last-known-good and is NEVER newly scheduled", async () => {
  const good = { payload: { catalogBrands: ["OldBrand"], catalogSyncStatus: "complete", catalogSyncedAt: "2026-08-01T00:00:00.000Z" } };
  const store = makeCatalogStore({ REMOVED1: good });
  // Discovery no longer returns REMOVED1; even a stale pending marker cannot schedule it.
  const directory = { catalogPendingAccountIds: new Set(["REMOVED1", "STILL1"]), catalogUnavailable: new Map() };
  assert.deepEqual(catalogSyncEligibleAccounts(["STILL1"], directory), ["STILL1"], "the removed account (absent from discovery) is never scheduled");
  // Its LKG snapshot is untouched -- nothing deletes it.
  assert.deepEqual(store.snapshot("REMOVED1").payload.catalogBrands, ["OldBrand"], "the removed account keeps its last-known-good brand map");
  // The durable directory retains it as inactive/read-only, never dropped.
  const merged = mergeAccountDirectory(
    [{ id: "REMOVED1", name: "Gone Co", country: "US" }, { id: "STILL1", name: "Still Co", country: "US" }],
    [{ id: "STILL1", name: "Still Co", country: "US" }],
  );
  assert.equal(merged.find((a) => a.id === "REMOVED1")?.active, false, "the removed account is retained as inactive/read-only");
  assert.equal(merged.find((a) => a.id === "STILL1")?.active, true, "the still-present account stays active");
});

await asyncTest("blocker 6: primary and dormant secondary records never merge; the primary public id is used and the legacy secondary id is not mutated", async () => {
  // The SAME raw seller id is returned by BOTH organisations.
  const merged = mergeDiscoveredDataDoeAccounts([
    { connection: PRIMARY_CONN, accounts: [{ id: "SELLER9", name: "Acme" }] },
    { connection: SECONDARY_CONN, accounts: [{ id: "SELLER9", name: "Acme" }] },
  ]);
  assert.deepEqual(merged.map((a) => a.id).sort(), ["SELLER9", "dd-secondary:SELLER9"], "two distinct public ids -- never merged into one");
  // Only the primary is catalog-eligible; the dormant secondary is skipped.
  const directory = { catalogPendingAccountIds: new Set(["SELLER9", "dd-secondary:SELLER9"]), catalogUnavailable: new Map() };
  assert.deepEqual(catalogSyncEligibleAccounts(merged.map((a) => a.id), directory), ["SELLER9"], "only the primary account is scheduled");
  // Resolution routes each to the right connection: the primary raw id is not mutated and the
  // secondary keeps its public prefix (its raw id is used only for the secondary API call).
  const conns = [PRIMARY_CONN, SECONDARY_CONN];
  const p = resolveDataDoeAccountIds(["SELLER9"], conns);
  assert.equal(p.connection.id, "primary");
  assert.equal(p.rawAccountIds[0], "SELLER9", "the primary raw seller id is used verbatim");
  const s = resolveDataDoeAccountIds(["dd-secondary:SELLER9"], conns);
  assert.equal(s.connection.id, "secondary");
  assert.equal(s.rawAccountIds[0], "SELLER9", "the secondary's raw id is used for its own API call");
  assert.deepEqual(s.accountIds, ["dd-secondary:SELLER9"], "the public secondary id keeps its prefix (never stripped/mutated)");
});

await asyncTest("blocker 6: adding accounts needs NO source-code account or country list update", async () => {
  // The active set is derived from live discovery + the persisted directory + the pure
  // reconcilers -- never a hard-coded enumeration.
  assert.match(DATADOE_SRC, /discoverConnectedAccounts\(connections\)/, "accounts come from live discovery");
  assert.match(DATADOE_SRC, /mergeAccountDirectory\(/, "the directory is reconciled from discovery, not a literal list");
  assert.match(DATADOE_SRC, /catalogSyncEligibleAccounts\(/, "scheduling is derived from discovery, not a literal list");
  // Two arbitrary, never-before-seen accounts in two different countries flow through with no
  // code change: discovery -> directory -> eligible, purely from their discovered ids.
  const a = { id: "zz-brandnew-1", name: "New AU", country: "AU", currency: "AUD" };
  const b = { id: "zz-brandnew-2", name: "New JP", country: "JP", currency: "JPY" };
  for (const acc of [a, b]) assert.doesNotMatch(DATADOE_SRC, new RegExp(acc.id), `${acc.id} is not hard-coded`);
  const merged = mergeAccountDirectory([], [a, b]);
  assert.deepEqual(merged.map((x) => x.id).sort(), ["zz-brandnew-1", "zz-brandnew-2"], "both new accounts appear from discovery alone");
  assert.deepEqual(
    catalogSyncEligibleAccounts(merged.map((x) => x.id), { catalogPendingAccountIds: new Set(merged.map((x) => x.id)) }),
    ["zz-brandnew-1", "zz-brandnew-2"],
    "both are scheduled purely from their discovered ids",
  );
});

/* =============== Server-owned action manifest orchestration (blockers 1-3) =============== */

// In-memory action-manifest store with the SAME optimistic-concurrency (rev CAS) contract as
// production: loadManifest deep-copies (carrying the stored rev); saveManifest CREATES at rev 1
// when the incoming manifest has no rev, otherwise CAS-updates -- returning the new rev when the
// stored row is still at manifest.rev, or `false` when a concurrent write moved it on. manifest()
// returns the RAW stored row so a test can simulate the server reordering the queue.
function makeManifestStore() {
  const manifests = new Map();
  return {
    manifests,
    loadManifest: (actionId) => Promise.resolve(manifests.has(actionId) ? JSON.parse(JSON.stringify(manifests.get(actionId))) : null),
    saveManifest: (actionId, manifest) => {
      if (manifest.rev == null) { // CREATE = insert-if-absent (never overwrite)
        if (manifests.has(actionId)) return Promise.resolve(false); // create conflict
        manifests.set(actionId, JSON.parse(JSON.stringify({ ...manifest, rev: 1 })));
        return Promise.resolve(1);
      }
      const cur = manifests.get(actionId);
      if (!cur || cur.rev !== manifest.rev) return Promise.resolve(false); // CAS lost
      const rev = manifest.rev + 1;
      manifests.set(actionId, JSON.parse(JSON.stringify({ ...manifest, rev })));
      return Promise.resolve(rev);
    },
    manifest: (actionId) => manifests.get(actionId) || null,
    // Seed an EXISTING manifest at a given rev (default 1) -- for tests that model a prior action.
    seed: (actionId, manifest, rev = 1) => { manifests.set(actionId, JSON.parse(JSON.stringify({ ...manifest, rev }))); },
  };
}
// Directory shape sharedSnapshotBrandAccounts returns; only the fields the orchestrator reads.
const dir = (pending = [], unavailable = []) => ({ catalogPendingAccountIds: new Set(pending.map(String)), catalogUnavailable: new Map(unavailable.map((id) => [String(id), CATALOG_SOURCE_UNAVAILABLE])) });
const ORCH_CONNS = [PRIMARY];
// A counting fetchCatalog: one call == one DataDoe export. Records the short source id + account.
function countingFetch() {
  const calls = { n: 0, accounts: [], sourceIds: [] };
  const fetchCatalog = ({ sourceId, rawAccountId }) => { calls.n += 1; calls.accounts.push(rawAccountId); calls.sourceIds.push(sourceId); return [{ child_asin: `${rawAccountId}-A1`, product_brand: `Brand-${rawAccountId}` }]; };
  return { calls, fetchCatalog };
}
const firstClick = (actionId, ids, directory, deps, extra = {}) => orchestrateBrandCatalogAction(
  { actionId, userId: "admin-1", isContinuation: false, authorizedPrimaryIds: ids, directory, connections: ORCH_CONNS, ...extra }, deps);
const continueAction = (actionId, cursor, ids, deps, extra = {}) => orchestrateBrandCatalogAction(
  { actionId, userId: "admin-1", isContinuation: true, clientCursor: cursor, authorizedPrimaryIds: ids, directory: {}, connections: ORCH_CONNS, ...extra }, deps);

await asyncTest("orchestration 1: start ACT1 then continue with ACT2 -> 409, zero DataDoe exports", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  const { calls, fetchCatalog } = countingFetch();
  const deps = { ...cat, ...man, fetchCatalog };
  const r1 = await firstClick("ACT1", ["A1", "A2"], dir(["A1", "A2"]), deps);
  assert.equal(r1.conflict, false, "ACT1 first click is valid");
  assert.equal(calls.n, 1, "ACT1 attempted exactly one account (one export)");
  const before = calls.n;
  const r2 = await continueAction("ACT2", ["A2"], ["A1", "A2"], deps);
  assert.equal(r2.conflict, true, "a continuation under a different action id is a conflict");
  assert.equal(r2.code, BRAND_DIRECTORY_ACTION_CONFLICT);
  assert.equal(calls.n, before, "the ACT2 continuation created ZERO exports");
});

await asyncTest("orchestration 2: unknown-action continuation -> 409, zero exports", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  const { calls, fetchCatalog } = countingFetch();
  const r = await continueAction("NEVER-STARTED", ["A1"], ["A1"], { ...cat, ...man, fetchCatalog });
  assert.equal(r.conflict, true, "a continuation never creates an action implicitly");
  assert.equal(r.code, BRAND_DIRECTORY_ACTION_CONFLICT);
  assert.equal(calls.n, 0, "zero exports");
});

await asyncTest("orchestration 3: changed admin/user on a continuation -> 409, zero exports", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  const { calls, fetchCatalog } = countingFetch();
  const deps = { ...cat, ...man, fetchCatalog };
  await firstClick("ACT1", ["A1", "A2"], dir(["A1", "A2"]), deps); // created by admin-1
  const before = calls.n;
  const r = await orchestrateBrandCatalogAction({ actionId: "ACT1", userId: "admin-2", isContinuation: true, clientCursor: ["A2"], authorizedPrimaryIds: ["A1", "A2"], directory: {}, connections: ORCH_CONNS }, deps);
  assert.equal(r.conflict, true, "a different admin cannot drive another admin's action");
  assert.equal(calls.n, before, "zero exports on wrong admin");
});

await asyncTest("orchestration 4: tampered cursor (injected/removed/reordered/duplicated) -> 409 before DataDoe", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  const { calls, fetchCatalog } = countingFetch();
  const deps = { ...cat, ...man, fetchCatalog };
  await firstClick("ACT1", ["A1", "A2", "A3"], dir(["A1", "A2", "A3"]), deps); // attempts A1 -> remaining [A2,A3]
  assert.deepEqual(man.manifest("ACT1").remaining, ["A2", "A3"]);
  const before = calls.n; // == 1
  for (const [label, cursor] of [["reordered", ["A3", "A2"]], ["injected", ["A2", "A3", "A9"]], ["removed", ["A2"]], ["duplicated", ["A2", "A2"]]]) {
    const r = await continueAction("ACT1", cursor, ["A1", "A2", "A3"], deps);
    assert.equal(r.conflict, true, `${label} cursor is a conflict`);
    assert.equal(r.code, BRAND_DIRECTORY_ACTION_CONFLICT);
  }
  assert.equal(calls.n, before, "no tampered cursor created any export");
  assert.deepEqual(man.manifest("ACT1").remaining, ["A2", "A3"], "the authoritative queue was never mutated by a tampered cursor");
});

await asyncTest("orchestration 5: the server manifest determines the next account, not catalogSyncAccountIds", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  const { calls, fetchCatalog } = countingFetch();
  const deps = { ...cat, ...man, fetchCatalog };
  await firstClick("ACT1", ["A1", "A2", "A3"], dir(["A1", "A2", "A3"]), deps); // remaining [A2,A3]
  // The server authoritatively reorders its own queue; the client cannot know or change it.
  man.manifest("ACT1").remaining = ["A3", "A2"];
  const stale = await continueAction("ACT1", ["A2", "A3"], ["A1", "A2", "A3"], deps); // client's old view
  assert.equal(stale.conflict, true, "a cursor that does not match the server queue is rejected");
  const ok = await continueAction("ACT1", ["A3", "A2"], ["A1", "A2", "A3"], deps); // matches server order
  assert.equal(ok.conflict, false);
  assert.equal(ok.next, "A3", "the NEXT account is the manifest head (A3), chosen by the server, not the client");
  assert.deepEqual(ok.remaining, ["A2"], "the server-owned queue advanced by exactly one");
});

await asyncTest("orchestration 6: claim refusal (concurrent owner) -> zero exports, account not falsely removed, action stays in progress until a durable outcome", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  const { calls, fetchCatalog } = countingFetch();
  const deps = { ...cat, ...man, fetchCatalog };
  // Another request already owns the claim for (A1, ACT1); no durable outcome yet.
  await cat.claimAttempt("A1", "ACT1");
  const r = await firstClick("ACT1", ["A1"], dir(["A1"]), deps);
  assert.equal(calls.n, 0, "the request that lost the claim created ZERO exports");
  assert.equal(r.status, "in-progress", "the action stays in progress");
  assert.equal(r.disposition, "in-progress");
  assert.deepEqual(r.remaining, ["A1"], "A1 is NOT falsely removed while the concurrent owner is mid-flight");
  // Once the owner writes a durable terminal outcome and frees the claim, a continuation advances.
  await cat.saveAttemptState("A1", "ACT1", { status: "complete", code: null, preservedLkg: false });
  await cat.releaseAttempt("A1", "ACT1");
  const done = await continueAction("ACT1", ["A1"], ["A1"], deps);
  assert.equal(calls.n, 0, "resolving via the durable outcome still creates zero exports in this request");
  assert.equal(done.disposition, "recorded", "the durable terminal outcome is observed");
  assert.deepEqual(done.remaining, [], "only now is A1 removed from the queue");
});

await asyncTest("orchestration 6b: two concurrent same-action first clicks create EXACTLY ONE export (one wins the insert-if-absent, the other 409s)", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  const { calls, fetchCatalog } = countingFetch();
  const deps = { ...cat, ...man, fetchCatalog };
  const [a, b] = await Promise.all([
    firstClick("ACT1", ["A1"], dir(["A1"]), deps),
    firstClick("ACT1", ["A1"], dir(["A1"]), deps),
  ]);
  assert.equal(calls.n, 1, "two concurrent same-action requests create exactly one DataDoe export");
  const winners = [a, b].filter((r) => !r.conflict && r.disposition === "exported");
  const losers = [a, b].filter((r) => r.conflict === true);
  assert.equal(winners.length, 1, "exactly one request won the create + exported");
  assert.equal(losers.length, 1, "the other lost the insert-if-absent race with a 409 and never exported");
  assert.equal(losers[0].code, BRAND_DIRECTORY_ACTION_CONFLICT);
});

await asyncTest("orchestration 7: attempting-marker write failure -> zero exports, typed operational failure, action NOT reported complete", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  const { calls, fetchCatalog } = countingFetch();
  const deps = {
    ...cat, ...man, fetchCatalog,
    saveAttemptState: (id, aid, st) => (st.status === "attempting" ? Promise.reject(new Error("marker persistence failed")) : cat.saveAttemptState(id, aid, st)),
  };
  const r = await firstClick("ACT1", ["A1"], dir(["A1"]), deps);
  assert.equal(calls.n, 0, "no export was created when the attempting marker could not be persisted");
  assert.equal(r.status, "operational-failure");
  assert.equal(r.operationalCode, BRAND_DIRECTORY_ACTION_UNAVAILABLE, "typed admin-safe operational-failure code");
  assert.notEqual(r.status, "complete", "the action is NOT reported complete");
  assert.deepEqual(r.remaining, ["A1"], "the account is not silently dropped");
  assert.equal(man.manifest("ACT1").status, "operational-failure", "the durable manifest records the stop");
});

await asyncTest("orchestration 8: outcome-write failure leaves a STALE attempting marker; a same-action replay creates zero exports and STOPS (operational), never re-exporting", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  const { calls, fetchCatalog } = countingFetch();
  const deps = {
    ...cat, ...man, fetchCatalog,
    // The pre-export 'attempting' marker persists; the TERMINAL outcome write fails. The claim
    // is released in the finally, so the attempting marker is now STALE (lock no longer held).
    saveAttemptState: (id, aid, st) => (st.status === "attempting" ? cat.saveAttemptState(id, aid, st) : Promise.reject(new Error("outcome persistence failed"))),
  };
  const r1 = await firstClick("ACT1", ["A1"], dir(["A1"]), deps);
  assert.equal(calls.n, 1, "the first invocation created its one export");
  assert.equal(cat.attempt("A1", "ACT1").status, "attempting", "the durable attempting marker remains (terminal write failed)");
  // Force A1 back onto the authoritative queue to prove a same-action replay cannot re-export it.
  man.manifest("ACT1").remaining = ["A1"];
  man.manifest("ACT1").status = "in-progress";
  const replay = await continueAction("ACT1", ["A1"], ["A1"], deps);
  assert.equal(calls.n, 1, "the same-action replay created ZERO additional exports");
  assert.equal(replay.disposition, "operational-failure", "an attempting marker with a free lock is stale/uncertain -> stop, never terminal-recorded");
  assert.equal(replay.status, "operational-failure", "the action stops and requires a NEW explicit action");
  assert.equal(cat.attempt("A1", "ACT1").status, "attempting", "the durable attempting state is still visible");
});

await asyncTest("orchestration 9: a newly discovered primary account is automatically included and attempted exactly once", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  const { calls, fetchCatalog } = countingFetch();
  const NEW = "NEWLY-CONNECTED-1";
  const src = await readFile(new URL("../api/datadoe.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, new RegExp(NEW), "the new account id is not hard-coded / mapped in source");
  const r = await firstClick(`ACT-${NEW}`, [NEW], dir([NEW]), { ...cat, ...man, fetchCatalog });
  assert.equal(calls.n, 1, "the new account was attempted exactly once");
  assert.deepEqual(calls.accounts, [NEW]);
  assert.equal(cat.snapshot(NEW).payload.catalogSyncStatus, "complete");
  assert.equal(r.status, "complete");
});

await asyncTest("orchestration 10: an already-complete account is not re-exported (approved eligibility policy preserved)", async () => {
  const complete = { payload: { catalogBrands: ["DoneBrand"], catalogSyncStatus: "complete", catalogSyncedAt: "2026-08-01T00:00:00.000Z" } };
  const cat = makeCatalogStore({ COMPLETE1: complete }); const man = makeManifestStore();
  const { calls, fetchCatalog } = countingFetch();
  // COMPLETE1 is not pending/unavailable, so it is not in the eligible queue.
  const r = await firstClick("ACT1", ["NEW1", "COMPLETE1"], dir(["NEW1"]), { ...cat, ...man, fetchCatalog });
  assert.deepEqual(r.remaining.concat(calls.accounts).filter((id) => id === "COMPLETE1"), [], "COMPLETE1 is never queued or attempted");
  assert.deepEqual(calls.accounts, ["NEW1"], "only the new account was exported");
});

await asyncTest("orchestration 11: a removed account is omitted from the new action and its LKG stays byte-identical", async () => {
  const good = { source_refreshed_at: "2026-08-01T00:00:00.000Z", payload: { catalogBrands: ["OldBrand"], catalogSyncStatus: "complete", catalogSyncedAt: "2026-08-01T00:00:00.000Z" } };
  const goodBytes = JSON.stringify(good);
  const cat = makeCatalogStore({ REMOVED1: good }); const man = makeManifestStore();
  const { calls, fetchCatalog } = countingFetch();
  // Discovery no longer returns REMOVED1; even a stale pending marker cannot schedule it.
  const r = await firstClick("ACT1", ["STILL1"], dir(["REMOVED1", "STILL1"]), { ...cat, ...man, fetchCatalog });
  assert.ok(!r.remaining.includes("REMOVED1") && !calls.accounts.includes("REMOVED1"), "the removed account is never queued or attempted");
  assert.equal(JSON.stringify(cat.snapshot("REMOVED1")), goodBytes, "the removed account's LKG snapshot is byte-identical");
  // The directory reconciler retains it inactive/read-only.
  const merged = mergeAccountDirectory([{ id: "REMOVED1", name: "Gone" }, { id: "STILL1", name: "Still" }], [{ id: "STILL1", name: "Still" }]);
  assert.equal(merged.find((a) => a.id === "REMOVED1")?.active, false);
});

await asyncTest("orchestration 12: a rediscovered account becomes active again and is eligible per its saved catalog state", async () => {
  // It reappears in discovery; the directory reconciler flips it back to active.
  const merged = mergeAccountDirectory([{ id: "R1", name: "R", active: false }], [{ id: "R1", name: "R" }]);
  assert.equal(merged.find((a) => a.id === "R1")?.active, true, "a rediscovered account is active again");
  // Its saved catalog is unavailable, so it is eligible and attempted once in the new action.
  const cat = makeCatalogStore({ R1: { payload: { catalogBrands: [], catalogSyncStatus: "unavailable", catalogSyncCode: CATALOG_SOURCE_UNAVAILABLE } } });
  const man = makeManifestStore();
  const { calls, fetchCatalog } = countingFetch();
  const r = await firstClick("ACT1", ["R1"], dir([], ["R1"]), { ...cat, ...man, fetchCatalog });
  assert.deepEqual(calls.accounts, ["R1"], "the rediscovered account is attempted once");
  assert.equal(r.status, "complete");
});

await asyncTest("orchestration 13: primary and dd-secondary with the same raw seller id never merge; only primary is attempted", async () => {
  const merged = mergeDiscoveredDataDoeAccounts([
    { connection: { id: "primary", label: "Primary DataDoe", accountPrefix: "" }, accounts: [{ id: "SELLER9", name: "Acme" }] },
    { connection: { id: "secondary", label: "Secondary DataDoe", accountPrefix: "dd-secondary:" }, accounts: [{ id: "SELLER9", name: "Acme" }] },
  ]);
  assert.deepEqual(merged.map((a) => a.id).sort(), ["SELLER9", "dd-secondary:SELLER9"]);
  const cat = makeCatalogStore(); const man = makeManifestStore();
  const { calls, fetchCatalog } = countingFetch();
  const r = await firstClick("ACT1", merged.map((a) => a.id), dir(["SELLER9", "dd-secondary:SELLER9"]), { ...cat, ...man, fetchCatalog });
  assert.deepEqual(calls.accounts, ["SELLER9"], "only the primary account reached DataDoe; the dd-secondary id was never routed to primary");
  assert.ok(!r.remaining.includes("dd-secondary:SELLER9"), "the dormant secondary is never in the primary queue");
});

// A status-aware retention model: action manifests (status/age/expiresAt), their attempt rows,
// and LKG + account-directory rows that must NEVER be touched. `add(id, status, ageDays,
// accountIds, expiresDaysAgo)`: ageDays/expiresDaysAgo are DAYS BEFORE NOW (a positive
// expiresDaysAgo means expiresAt has passed; null means no expiresAt). The delete/expiry
// primitives report ACCURATELY: they resolve true on success and throw when injected to fail.
function makeRetentionModel(NOW) {
  const DAY = 86_400_000;
  const iso = (d) => new Date(NOW - d * DAY).toISOString();
  const actions = new Map(); // actionId -> { actionId, status, updatedAt, expiresAt, accountIds }
  const attempts = new Set(); // `${actionId}::${accountId}`
  const untouchable = new Set(["lkg-catalog", "account-directory"]); // proof these are never deleted
  const add = (actionId, status, ageDays, accountIds, expiresDaysAgo = null) => {
    actions.set(actionId, { actionId, status, updatedAt: iso(ageDays), expiresAt: expiresDaysAgo == null ? null : iso(expiresDaysAgo), accountIds, rev: 1 });
    for (const id of accountIds) attempts.add(`${actionId}::${id}`);
  };
  return {
    actions, attempts, untouchable, add,
    listOldActions: ({ cutoffIso }) => Promise.resolve(
      [...actions.values()].filter((a) => a.updatedAt < cutoffIso).map((a) => ({ actionId: a.actionId, status: a.status, updatedAt: a.updatedAt, accountIds: a.accountIds }))
    ),
    loadManifest: (actionId) => Promise.resolve(actions.has(actionId) ? JSON.parse(JSON.stringify(actions.get(actionId))) : null),
    // Same rev-CAS + insert-if-absent contract as production/makeManifestStore.
    saveManifest: (actionId, m) => {
      if (m.rev == null) { if (actions.has(actionId)) return Promise.resolve(false); actions.set(actionId, JSON.parse(JSON.stringify({ ...m, rev: 1 }))); return Promise.resolve(1); }
      const cur = actions.get(actionId);
      if (!cur || cur.rev !== m.rev) return Promise.resolve(false);
      const rev = m.rev + 1;
      actions.set(actionId, JSON.parse(JSON.stringify({ ...m, rev })));
      return Promise.resolve(rev);
    },
    deleteManifest: (actionId) => { actions.delete(actionId); return Promise.resolve(true); },
    deleteAttempt: (accountId, actionId) => { attempts.delete(`${actionId}::${accountId}`); return Promise.resolve(true); },
  };
}

await asyncTest("orchestration 14: STATUS-AWARE retention deletes only terminal actions (attempts-then-manifest); active in-progress survives; LKG + account-directory untouched", async () => {
  const NOW = Date.parse("2026-08-12T00:00:00.000Z");
  const m = makeRetentionModel(NOW);
  m.add("INPROGRESS_OLD", "in-progress", 10, ["A1"], -5);     // old but expiresAt in the future -> SURVIVES in-progress
  m.add("COMPLETE_OLD", "complete", 10, ["A2"]);              // old terminal -> DELETED (attempt then manifest)
  m.add("OPFAIL_OLD", "operational-failure", 10, ["A3"]);     // old terminal -> DELETED
  m.add("EXPIRED_OLD", "expired", 10, ["A4"]);                // old terminal -> DELETED
  m.add("COMPLETE_RECENT", "complete", 1, ["A5"]);            // recent (<7d) -> SURVIVES (not even listed)
  await pruneBrandCatalogActionRecords({ ...m, nowMs: () => NOW });
  assert.deepEqual([...m.actions.keys()].sort(), ["COMPLETE_RECENT", "INPROGRESS_OLD"], "old in-progress + recent complete survive; old terminal are pruned");
  assert.ok(m.attempts.has("INPROGRESS_OLD::A1"), "an old attempting row belonging to an active action survives");
  for (const gone of ["COMPLETE_OLD::A2", "OPFAIL_OLD::A3", "EXPIRED_OLD::A4"]) assert.ok(!m.attempts.has(gone), `${gone} attempt pruned with its terminal action`);
  assert.ok(m.attempts.has("COMPLETE_RECENT::A5"), "a recent action's attempt survives");
  assert.deepEqual([...m.untouchable].sort(), ["account-directory", "lkg-catalog"], "LKG catalog and account-directory snapshots are never touched by retention");
});

await asyncTest("orchestration 14b: retention is best-effort -- a list or delete failure never throws (cannot fail a refresh)", async () => {
  const NOW = Date.parse("2026-08-12T00:00:00.000Z");
  await pruneBrandCatalogActionRecords({ listOldActions: () => Promise.reject(new Error("list failed")), nowMs: () => NOW });
  const m = makeRetentionModel(NOW);
  m.add("COMPLETE_OLD", "complete", 10, ["A2"]);
  await pruneBrandCatalogActionRecords({ ...m, deleteManifest: () => Promise.reject(new Error("delete failed")), nowMs: () => NOW });
  assert.ok(true, "no cleanup failure propagated");
});

/* =============== Retention integrity (PROBLEM 1 + PROBLEM 2) =============== */

await asyncTest("retention 1: an attempt-deletion FAILURE leaves the manifest AND every attempt row; a later successful pass deletes attempts then the manifest", async () => {
  const NOW = Date.parse("2026-08-12T00:00:00.000Z");
  const m = makeRetentionModel(NOW);
  m.add("COMPLETE_OLD", "complete", 10, ["A1", "A2"]);
  let failA1 = true;
  const order = [];
  const deleteAttempt = (accountId, actionId) => { if (accountId === "A1" && failA1) return Promise.reject(new Error("attempt delete failed")); order.push(`A:${accountId}`); m.attempts.delete(`${actionId}::${accountId}`); return Promise.resolve(true); };
  const deleteManifest = (actionId) => { order.push("M"); m.actions.delete(actionId); return Promise.resolve(true); };
  await pruneBrandCatalogActionRecords({ ...m, deleteAttempt, deleteManifest, nowMs: () => NOW });
  assert.ok(m.actions.has("COMPLETE_OLD"), "the manifest survives while an attempt delete is failing");
  assert.ok(m.attempts.has("COMPLETE_OLD::A1") && m.attempts.has("COMPLETE_OLD::A2"), "no attempt row was orphaned or lost");
  assert.deepEqual(order, [], "the manifest was NOT deleted (attempts not all confirmed)");
  // Next pass, storage healthy: attempts deleted first, then the manifest.
  failA1 = false;
  await pruneBrandCatalogActionRecords({ ...m, deleteAttempt, deleteManifest, nowMs: () => NOW });
  assert.ok(!m.actions.has("COMPLETE_OLD"), "the next pass deletes the manifest");
  assert.ok(!m.attempts.has("COMPLETE_OLD::A1") && !m.attempts.has("COMPLETE_OLD::A2"), "attempts deleted");
  assert.deepEqual(order, ["A:A1", "A:A2", "M"], "ordering is attempts-first, manifest-last");
});

await asyncTest("retention 2: a manifest-deletion FAILURE leaves the manifest (attempts may already be gone); a later pass completes cleanup idempotently", async () => {
  const NOW = Date.parse("2026-08-12T00:00:00.000Z");
  const m = makeRetentionModel(NOW);
  m.add("COMPLETE_OLD", "complete", 10, ["A1"]);
  let failManifest = true;
  const deleteManifest = (actionId) => { if (failManifest) return Promise.reject(new Error("manifest delete failed")); m.actions.delete(actionId); return Promise.resolve(true); };
  await pruneBrandCatalogActionRecords({ ...m, deleteManifest, nowMs: () => NOW });
  assert.ok(!m.attempts.has("COMPLETE_OLD::A1"), "the attempt row was already deleted (attempts precede the manifest)");
  assert.ok(m.actions.has("COMPLETE_OLD"), "the manifest survives a failed delete and is retried");
  // Next pass: the missing attempt row is an idempotent success; the manifest is deleted.
  failManifest = false;
  await pruneBrandCatalogActionRecords({ ...m, deleteManifest, nowMs: () => NOW });
  assert.ok(!m.actions.has("COMPLETE_OLD"), "the next pass completes cleanup idempotently");
});

await asyncTest("retention 3: an OLD in-progress action past expiresAt is transitioned to 'expired' (not directly deleted); attempts remain until terminal expiry is confirmed", async () => {
  const NOW = Date.parse("2026-08-12T00:00:00.000Z");
  const m = makeRetentionModel(NOW);
  m.add("INPROGRESS_ABANDONED", "in-progress", 40, ["A1"], 10); // updatedAt 40d, expiresAt 10d ago (passed)
  const order = [];
  const deleteManifest = (actionId) => { order.push(`M:${actionId}`); m.actions.delete(actionId); return Promise.resolve(true); };
  const deleteAttempt = (accountId, actionId) => { order.push(`A:${actionId}:${accountId}`); m.attempts.delete(`${actionId}::${accountId}`); return Promise.resolve(true); };
  await pruneBrandCatalogActionRecords({ ...m, deleteManifest, deleteAttempt, nowMs: () => NOW });
  assert.equal(m.actions.get("INPROGRESS_ABANDONED").status, "expired", "the first pass durably persists the terminal 'expired' state");
  assert.deepEqual(order, [], "the in-progress action was NOT directly deleted");
  assert.ok(m.attempts.has("INPROGRESS_ABANDONED::A1"), "its attempts remain until the persisted terminal state is observed by a later pass");
});

await asyncTest("retention 4: an expiry-transition FAILURE preserves the in-progress manifest and all its attempts; the refresh is not failed", async () => {
  const NOW = Date.parse("2026-08-12T00:00:00.000Z");
  const m = makeRetentionModel(NOW);
  m.add("INPROGRESS_ABANDONED", "in-progress", 40, ["A1", "A2"], 10);
  const saveManifest = () => Promise.reject(new Error("expiry write failed"));
  await pruneBrandCatalogActionRecords({ ...m, saveManifest, nowMs: () => NOW });
  assert.equal(m.actions.get("INPROGRESS_ABANDONED").status, "in-progress", "the action remains in-progress when the expiry write fails");
  assert.ok(m.attempts.has("INPROGRESS_ABANDONED::A1") && m.attempts.has("INPROGRESS_ABANDONED::A2"), "all attempt rows survive for retry");
});

await asyncTest("retention 5: a CONFIRMED old expired/complete/operational-failure action has its attempts deleted first, then its manifest", async () => {
  const NOW = Date.parse("2026-08-12T00:00:00.000Z");
  const m = makeRetentionModel(NOW);
  m.add("EXPIRED_OLD", "expired", 10, ["A1", "A2"]);
  m.add("COMPLETE_OLD", "complete", 10, ["A3"]);
  m.add("OPFAIL_OLD", "operational-failure", 10, ["A4"]);
  const order = [];
  const deleteAttempt = (accountId, actionId) => { order.push(`A:${actionId}:${accountId}`); m.attempts.delete(`${actionId}::${accountId}`); return Promise.resolve(true); };
  const deleteManifest = (actionId) => { order.push(`M:${actionId}`); m.actions.delete(actionId); return Promise.resolve(true); };
  await pruneBrandCatalogActionRecords({ ...m, deleteAttempt, deleteManifest, nowMs: () => NOW });
  assert.equal(m.actions.size, 0, "all three terminal actions are deleted");
  assert.equal(m.attempts.size, 0, "all their attempts are deleted");
  for (const [actionId, accounts] of [["EXPIRED_OLD", ["A1", "A2"]], ["COMPLETE_OLD", ["A3"]], ["OPFAIL_OLD", ["A4"]]]) {
    const mIdx = order.indexOf(`M:${actionId}`);
    for (const a of accounts) assert.ok(order.indexOf(`A:${actionId}:${a}`) < mIdx, `${actionId}: attempt ${a} deleted before the manifest`);
  }
});

await asyncTest("retention 6: recent in-progress and recent terminal rows survive their retention windows", async () => {
  const NOW = Date.parse("2026-08-12T00:00:00.000Z");
  const m = makeRetentionModel(NOW);
  m.add("INPROGRESS_RECENT", "in-progress", 1, ["A1"], -5); // recent + expiresAt in the future
  m.add("COMPLETE_RECENT", "complete", 1, ["A2"]);
  await pruneBrandCatalogActionRecords({ ...m, nowMs: () => NOW });
  assert.ok(m.actions.has("INPROGRESS_RECENT") && m.actions.has("COMPLETE_RECENT"), "recent rows survive");
  assert.ok(m.attempts.has("INPROGRESS_RECENT::A1") && m.attempts.has("COMPLETE_RECENT::A2"), "their attempts survive");
});

/* =============== P2 manifest-transition concurrency (CAS on rev) -- both interleavings =============== */

await asyncTest("P2 race A: a continuation that COMMITS between retention's re-read and its expiry CAS is NOT overwritten by retention", async () => {
  const NOW = Date.parse("2026-08-12T00:00:00.000Z");
  const m = makeRetentionModel(NOW);
  m.add("ACT1", "in-progress", 40, ["A1"], 10); // rev 1, expiresAt passed -> retention will try to expire it
  const realSave = m.saveManifest;
  let interleaved = false;
  const saveManifest = (actionId, mf) => {
    if (!interleaved) {
      interleaved = true;
      // The continuation advances the action to completion (rev 1 -> 2) just BEFORE retention's CAS.
      realSave(actionId, { ...m.actions.get(actionId), status: "complete", remaining: [], current: null, rev: 1 });
    }
    return realSave(actionId, mf); // retention's CAS(expected rev 1) now LOSES to the committed rev 2
  };
  await pruneBrandCatalogActionRecords({ ...m, saveManifest, nowMs: () => NOW });
  assert.equal(m.actions.get("ACT1").status, "complete", "retention did NOT overwrite the continuation's committed state");
  assert.notEqual(m.actions.get("ACT1").status, "expired", "the continuation was not clobbered to expired");
  assert.equal(m.actions.get("ACT1").rev, 2, "the continuation's committed version stands");
});

await asyncTest("P2 race B: after retention EXPIRES first, a stale continuation's CAS loses and it does NOT restore in-progress/complete", async () => {
  const cat = makeCatalogStore({}); const man = makeManifestStore();
  man.seed("ACT1", { actionId: "ACT1", userId: "admin-1", scopeHash: "SCOPE", primaryAccountIds: ["A1"], remaining: ["A1"], current: null, status: "in-progress", code: null, createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z" }, 1);
  // The continuation loaded a STALE snapshot (rev 1, in-progress) before retention acted.
  const staleView = JSON.parse(JSON.stringify(man.manifest("ACT1")));
  const loadManifest = () => Promise.resolve(JSON.parse(JSON.stringify(staleView)));
  // Retention (elsewhere) commits the terminal "expired" transition FIRST (rev 1 -> 2).
  const won = await man.saveManifest("ACT1", { ...man.manifest("ACT1"), status: "expired" });
  assert.equal(won, 2, "retention's expiry CAS won at rev 2");
  assert.equal(man.manifest("ACT1").status, "expired");
  // The account attempt is already terminal, so the stale continuation performs NO export.
  await cat.saveAttemptState("A1", "ACT1", { status: "complete", code: null, preservedLkg: false });
  const { calls, fetchCatalog } = countingFetch();
  const r = await orchestrateBrandCatalogAction(
    { actionId: "ACT1", userId: "admin-1", isContinuation: true, clientCursor: ["A1"], authorizedPrimaryIds: ["A1"], directory: {}, connections: ORCH_CONNS },
    { ...cat, ...man, loadManifest, fetchCatalog, scopeHashOf: () => "SCOPE" },
  );
  assert.equal(r.conflict, true, "the stale continuation gets a 409 (its advance CAS lost)");
  assert.equal(man.manifest("ACT1").status, "expired", "the stale continuation did NOT restore in-progress/complete over the expired row");
  assert.equal(calls.n, 0, "one-export-per-request preserved: the already-terminal account is not re-exported");
});

/* =============== P1 delayed-CREATE race (insert-if-absent) + rev validation =============== */

await asyncTest("P1 delayed create (A completed): B loaded missing, A creates+advances to complete, B resumes create -> loses, no overwrite, no export", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  // A: normal first click -> creates rev 1, exports A1, advances to complete (rev 2, remaining []).
  const fA = countingFetch();
  const rA = await firstClick("ACT1", ["A1"], dir(["A1"]), { ...cat, ...man, fetchCatalog: fA.fetchCatalog });
  assert.equal(rA.status, "complete");
  assert.equal(fA.calls.n, 1, "A exported exactly once");
  const revAfterA = man.manifest("ACT1").rev;
  // B: loaded "missing" earlier and only now resumes its CREATE (insert-if-absent).
  const fB = countingFetch();
  const rB = await orchestrateBrandCatalogAction(
    { actionId: "ACT1", userId: "admin-1", isContinuation: false, authorizedPrimaryIds: ["A1"], directory: dir(["A1"]), connections: ORCH_CONNS },
    { ...cat, ...man, loadManifest: () => Promise.resolve(null), fetchCatalog: fB.fetchCatalog },
  );
  assert.equal(rB.conflict, true, "the delayed creator loses the insert-if-absent race with a 409");
  assert.equal(rB.code, BRAND_DIRECTORY_ACTION_CONFLICT);
  assert.equal(fB.calls.n, 0, "the delayed creator creates ZERO exports");
  assert.equal(man.manifest("ACT1").status, "complete", "the delayed creator did NOT overwrite the completed manifest");
  assert.equal(man.manifest("ACT1").rev, revAfterA, "rev is unchanged by the losing create");
});

await asyncTest("P1 delayed create (A stopped): A commits operational-failure, B resumes create -> loses, does NOT reopen it or export", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  // A: create rev 1, then the claim persistence fails -> operational-failure (rev 2).
  const fA = countingFetch();
  const rA = await firstClick("ACT1", ["A1"], dir(["A1"]), { ...cat, ...man, claimAttempt: () => Promise.reject(new Error("claim persist failed")), fetchCatalog: fA.fetchCatalog });
  assert.equal(rA.status, "operational-failure");
  assert.equal(man.manifest("ACT1").status, "operational-failure");
  assert.equal(fA.calls.n, 0);
  const revAfterA = man.manifest("ACT1").rev;
  // B: delayed create loses the insert-if-absent race.
  const fB = countingFetch();
  const rB = await orchestrateBrandCatalogAction(
    { actionId: "ACT1", userId: "admin-1", isContinuation: false, authorizedPrimaryIds: ["A1"], directory: dir(["A1"]), connections: ORCH_CONNS },
    { ...cat, ...man, loadManifest: () => Promise.resolve(null), fetchCatalog: fB.fetchCatalog },
  );
  assert.equal(rB.conflict, true, "the delayed creator loses with a 409");
  assert.equal(fB.calls.n, 0, "no export");
  assert.equal(man.manifest("ACT1").status, "operational-failure", "the stopped action is NOT reopened");
  assert.equal(man.manifest("ACT1").rev, revAfterA, "rev is unchanged");
});

await asyncTest("P1 rev validation: a loaded manifest with a missing/zero/negative/fractional/string/malformed rev FAILS CLOSED (409) with zero writes and zero exports", async () => {
  for (const badRev of [undefined, null, 0, -1, 1.5, "1", "abc", NaN]) {
    const cat = makeCatalogStore(); const man = makeManifestStore();
    // Inject a corrupt/legacy row directly (bypassing seed's positive-rev default).
    man.manifests.set("ACT1", { actionId: "ACT1", userId: "admin-1", scopeHash: "SCOPE", primaryAccountIds: ["A1"], remaining: ["A1"], current: null, status: "in-progress", code: null, expiresAt: "2027-01-01T00:00:00.000Z", rev: badRev });
    let writes = 0;
    const saveManifest = (a, m) => { writes += 1; return man.saveManifest(a, m); };
    const f = countingFetch();
    const r = await orchestrateBrandCatalogAction(
      { actionId: "ACT1", userId: "admin-1", isContinuation: true, clientCursor: ["A1"], authorizedPrimaryIds: ["A1"], directory: {}, connections: ORCH_CONNS },
      { ...cat, ...man, saveManifest, fetchCatalog: f.fetchCatalog, scopeHashOf: () => "SCOPE" },
    );
    assert.equal(r.conflict, true, `rev=${String(badRev)} fails closed with a 409`);
    assert.equal(writes, 0, `rev=${String(badRev)} performs ZERO manifest writes`);
    assert.equal(f.calls.n, 0, `rev=${String(badRev)} performs ZERO exports`);
  }
  // A valid positive-integer rev is honoured (control).
  const cat = makeCatalogStore(); const man = makeManifestStore();
  man.seed("ACT1", { actionId: "ACT1", userId: "admin-1", scopeHash: "SCOPE", primaryAccountIds: ["A1"], remaining: ["A1"], current: null, status: "in-progress", code: null, expiresAt: "2027-01-01T00:00:00.000Z" }, 3);
  const f = countingFetch();
  const r = await orchestrateBrandCatalogAction(
    { actionId: "ACT1", userId: "admin-1", isContinuation: true, clientCursor: ["A1"], authorizedPrimaryIds: ["A1"], directory: {}, connections: ORCH_CONNS },
    { ...cat, ...man, fetchCatalog: f.fetchCatalog, scopeHashOf: () => "SCOPE" },
  );
  assert.equal(r.conflict, false, "a valid positive-integer rev is honoured");
  assert.equal(f.calls.n, 1, "and its account is exported once");
});

await asyncTest("P1 production wrapper: insertReportSnapshotIfAbsent sends ignore-duplicates (never merge) and distinguishes inserted vs conflict", async () => {
  // The request() helper captures SUPABASE_URL/KEY at import time, so load a FRESH, configured
  // copy of the module (cache-busted) and mock global.fetch -- isolated from the rest of the suite.
  const prev = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SECRET_KEY, svc: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "test-secret";
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const { insertReportSnapshotIfAbsent } = await import(`../lib/server/supabase.js?p1fresh=${passed}`);
  const originalFetch = global.fetch;
  const seen = [];
  const snap = { reportKey: "brand-catalog-action", accountId: "__brand-catalog-action__", paramsHash: "hash-1", params: {}, payload: { rev: 1 }, payloadBytes: 10 };
  try {
    // Absent -> the DB INSERTS and returns the row.
    global.fetch = async (url, options = {}) => { seen.push({ url: String(url), prefer: options.headers?.Prefer || "", method: options.method }); return new Response(JSON.stringify([{ id: "row-1" }]), { status: 201 }); };
    assert.equal(await insertReportSnapshotIfAbsent(snap), true, "a returned row means INSERTED");
    // Present -> ON CONFLICT DO NOTHING returns an EMPTY representation.
    global.fetch = async () => new Response(JSON.stringify([]), { status: 201 });
    assert.equal(await insertReportSnapshotIfAbsent(snap), false, "an empty representation means CONFLICT (already present, not merged)");
    // Semantics of the wire request.
    assert.match(seen[0].url, /on_conflict=report_key/, "targets the natural-key unique index");
    assert.match(seen[0].prefer, /resolution=ignore-duplicates/, "uses ignore-duplicates (insert-if-absent)");
    assert.doesNotMatch(seen[0].prefer, /merge-duplicates/, "NEVER merges/overwrites an existing row");
    assert.match(seen[0].prefer, /return=representation/, "asks for the representation to distinguish inserted vs conflict");
    // Transport/HTTP failure THROWS (never a silent false).
    global.fetch = async () => new Response(JSON.stringify({ message: "boom" }), { status: 500 });
    await assert.rejects(() => insertReportSnapshotIfAbsent(snap), /Supabase request failed/);
  } finally {
    global.fetch = originalFetch;
    process.env.SUPABASE_URL = prev.url; process.env.SUPABASE_SECRET_KEY = prev.key;
    if (prev.svc === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prev.svc;
  }
});

/* =============== P2 fail-closed rev invariant at EVERY boundary =============== */

const MALFORMED_REVS = [undefined, null, 0, -1, 1.5, "1", "abc", NaN, Number.MAX_SAFE_INTEGER, 2 ** 53];

await asyncTest("P2 retention rev invariant: an in-progress manifest with a malformed rev is NEVER expired or deleted -- zero saves/deletes, manifest + attempts preserved", async () => {
  const NOW = Date.parse("2026-08-12T00:00:00.000Z");
  for (const badRev of MALFORMED_REVS) {
    const m = makeRetentionModel(NOW);
    m.add("ACT1", "in-progress", 40, ["A1", "A2"], 10); // old, expiresAt passed, valid rev 1
    m.actions.get("ACT1").rev = badRev; // corrupt the stored rev
    let saves = 0, deletes = 0;
    const saveManifest = (a, mf) => { saves += 1; return m.saveManifest(a, mf); };
    const deleteManifest = (a) => { deletes += 1; return m.deleteManifest(a); };
    const deleteAttempt = (acct, a) => { deletes += 1; return m.deleteAttempt(acct, a); };
    await pruneBrandCatalogActionRecords({ ...m, saveManifest, deleteManifest, deleteAttempt, nowMs: () => NOW });
    const tag = String(badRev);
    assert.equal(saves, 0, `rev=${tag}: retention performed ZERO saves (never expires a malformed rev; never treats it as create)`);
    assert.equal(deletes, 0, `rev=${tag}: retention performed ZERO deletes`);
    assert.ok(m.actions.has("ACT1"), `rev=${tag}: the manifest is preserved`);
    assert.ok(m.attempts.has("ACT1::A1") && m.attempts.has("ACT1::A2"), `rev=${tag}: the attempts are preserved`);
    assert.equal(m.actions.get("ACT1").status, "in-progress", `rev=${tag}: the action is not expired`);
  }
  // Control: a VALID rev is expired normally (proves the guard is not over-broad).
  const m = makeRetentionModel(NOW);
  m.add("ACT1", "in-progress", 40, ["A1"], 10); // valid rev 1, expiresAt passed
  await pruneBrandCatalogActionRecords({ ...m, nowMs: () => NOW });
  assert.equal(m.actions.get("ACT1").status, "expired", "a valid-rev abandoned action IS expired");
});

await asyncTest("P2 production wrapper: casUpdateReportSnapshotByRev fails closed on a malformed expectedRev or payload.rev with ZERO fetch calls", async () => {
  const prev = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SECRET_KEY, svc: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "test-secret";
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const { casUpdateReportSnapshotByRev } = await import(`../lib/server/supabase.js?p2fresh=${passed}`);
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  try {
    global.fetch = async () => { fetchCalls += 1; return new Response(JSON.stringify([{ id: "row-1" }]), { status: 200 }); };
    // Malformed expectedRev -> THROWS before any fetch.
    for (const badRev of MALFORMED_REVS) {
      const before = fetchCalls;
      await assert.rejects(
        () => casUpdateReportSnapshotByRev({ reportKey: "k", accountId: "a", paramsHash: "h", expectedRev: badRev, payload: { rev: 2 } }),
        /expectedRev must be a positive safe integer/,
        `expectedRev=${String(badRev)} rejects`,
      );
      assert.equal(fetchCalls, before, `expectedRev=${String(badRev)} made ZERO fetch calls`);
    }
    // payload.rev !== expectedRev + 1 (incl. the string-concat "11" shape) -> THROWS before any fetch.
    for (const badPayloadRev of [undefined, "11", "2", 1, 3, NaN]) {
      const before = fetchCalls;
      await assert.rejects(
        () => casUpdateReportSnapshotByRev({ reportKey: "k", accountId: "a", paramsHash: "h", expectedRev: 1, payload: { rev: badPayloadRev } }),
        /payload\.rev must equal expectedRev \+ 1/,
        `payload.rev=${String(badPayloadRev)} rejects`,
      );
      assert.equal(fetchCalls, before, `payload.rev=${String(badPayloadRev)} made ZERO fetch calls`);
    }
    // A VALID pair issues exactly one PATCH and returns true when a row is returned.
    const before = fetchCalls;
    const won = await casUpdateReportSnapshotByRev({ reportKey: "k", accountId: "a", paramsHash: "h", expectedRev: 1, payload: { rev: 2 } });
    assert.equal(fetchCalls, before + 1, "a valid (expectedRev, payload.rev=expectedRev+1) pair issues exactly one PATCH");
    assert.equal(won, true, "a returned row means the CAS won");
  } finally {
    global.fetch = originalFetch;
    process.env.SUPABASE_URL = prev.url; process.env.SUPABASE_SECRET_KEY = prev.key;
    if (prev.svc === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prev.svc;
  }
});

await asyncTest("orchestration 15: the orchestrated export uses ONLY the short Product Catalog id; the obsolete long id is never sent", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  const { calls, fetchCatalog } = countingFetch();
  await firstClick("ACT1", ["A1"], dir(["A1"]), { ...cat, ...man, fetchCatalog });
  assert.deepEqual(calls.sourceIds, [PRODUCT_CATALOG_SHORT_ID], "the create-export used the short live source id");
  assert.ok(!calls.sourceIds.includes(PRODUCT_CATALOG_OBSOLETE_LONG_ID), "the obsolete long id is never sent");
});

await asyncTest("orchestration 16: no raw DataDoe/Supabase error reaches the browser through the orchestrator", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  const fetchCatalog = () => { throw new Error(`DataDoe export creation failed (404): {"message":"Source not found","statusCode":404} https://api.datadoe.com/api/v1/exports`); };
  const r = await firstClick("ACT1", ["A1"], dir(["A1"]), { ...cat, ...man, fetchCatalog });
  const blob = JSON.stringify([r, man.manifest("ACT1"), cat.snapshot("A1"), cat.attempt("A1", "ACT1")]);
  assert.doesNotMatch(blob, /Source not found|statusCode|https?:\/\/|api\/v1/i, "no raw DataDoe/Supabase detail in any orchestrator/manifest/attempt state");
  assert.equal(cat.attempt("A1", "ACT1").code, CATALOG_SOURCE_UNAVAILABLE, "only a typed code is recorded");
  for (const code of [BRAND_DIRECTORY_ACTION_CONFLICT, BRAND_DIRECTORY_ACTION_UNAVAILABLE]) assert.match(code, /^BRAND_DIRECTORY_ACTION_/, "action codes are typed constants");
});

/* =============== FIX 1: attempting is not terminal (fail-closed state machine) =============== */

await asyncTest("FIX 1 deferred concurrency: while A pauses INSIDE fetchCatalog, B sees attempting+held-lock -> zero exports, in-progress, no advance; only A's durable terminal advances", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  let exportCount = 0;
  let releaseA;
  const gateA = new Promise((res) => { releaseA = res; });
  const depsA = { ...cat, ...man, fetchCatalog: async () => { exportCount += 1; await gateA; return [{ child_asin: "A1x", product_brand: "Br" }]; } };
  const depsB = { ...cat, ...man, fetchCatalog: async () => { exportCount += 1; return [{ child_asin: "A1x", product_brand: "Br" }]; } };
  // 1. Start A (first click); it writes A1's attempting marker and PAUSES inside fetchCatalog.
  const pA = firstClick("ACT1", ["A1", "A2"], dir(["A1", "A2"]), depsA);
  await new Promise((r) => setTimeout(r, 0)); // let A reach the paused fetch (attempting written, lock held)
  assert.equal(cat.attempt("A1", "ACT1").status, "attempting", "A wrote the attempting marker before the export");
  assert.equal(cat.lockHeld("A1", "ACT1"), true, "A still holds the claim while paused");
  // 2-4. B runs while A is paused: zero exports, in-progress, keeps the queue, does NOT advance to A2.
  const rB = await continueAction("ACT1", ["A1", "A2"], ["A1", "A2"], depsB);
  assert.equal(exportCount, 1, "B created ZERO exports (only A's is in flight)");
  assert.equal(rB.disposition, "in-progress", "B sees a held claim -> in-progress (attempting is never terminal)");
  assert.equal(rB.next, "A1", "B did NOT advance to account 2");
  assert.deepEqual(rB.remaining, ["A1", "A2"], "B kept the same authoritative queue");
  // 5-6. Release A; only after its durable terminal outcome may the queue advance, with exactly one export for account 1.
  releaseA();
  await pA;
  assert.equal(exportCount, 1, "total create-export count for account 1 remains exactly one");
  assert.equal(cat.attempt("A1", "ACT1").status, "complete", "A's terminal outcome is durable");
  assert.deepEqual(man.manifest("ACT1").remaining, ["A2"], "A1 advanced only after A's durable terminal result");
});

await asyncTest("FIX 1 stale attempting after lock expiry: the SAME action creates zero exports and stops safely; a NEW action may attempt once", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  // A durable 'attempting' marker exists, but its lock is NOT held (released / expired).
  await cat.saveAttemptState("A1", "ACT1", { status: "attempting", code: null, preservedLkg: false });
  assert.equal(cat.lockHeld("A1", "ACT1"), false, "the attempt's lock is no longer held");
  const f1 = countingFetch();
  const r1 = await firstClick("ACT1", ["A1", "A2"], dir(["A1", "A2"]), { ...cat, ...man, fetchCatalog: f1.fetchCatalog });
  assert.equal(f1.calls.n, 0, "a stale attempting under the same action creates ZERO exports");
  assert.equal(r1.status, "operational-failure", "the action stops safely with a typed operational state");
  // A NEW action id may attempt the account exactly once.
  const f2 = countingFetch();
  const r2 = await firstClick("ACT2", ["A1", "A2"], dir(["A1", "A2"]), { ...cat, ...man, fetchCatalog: f2.fetchCatalog });
  assert.equal(f2.calls.n, 1, "a NEW action attempts the account exactly once");
  assert.equal(f2.calls.accounts[0], "A1");
  assert.equal(r2.status, "in-progress");
});

/* =============== FIX 2: manifest transitions must be durable before response =============== */

await asyncTest("FIX 2 advance-write failure: an exported terminal is durable but the manifest advance cannot persist -> NOT complete/advanced; recovery advances once with zero new exports", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  const { calls, fetchCatalog } = countingFetch();
  let saves = 0; // 1 = create; 2 = advance (fails once); later = recovery
  const saveManifest = (actionId, mf) => { saves += 1; if (saves === 2) return Promise.reject(new Error("advance write failed")); return man.saveManifest(actionId, mf); };
  const deps = { ...cat, ...man, saveManifest, fetchCatalog };
  const r1 = await firstClick("ACT1", ["A1", "A2"], dir(["A1", "A2"]), deps);
  assert.equal(calls.n, 1, "the export ran exactly once");
  assert.notEqual(r1.status, "complete", "the response is NOT reported complete/advanced when the advance write failed");
  assert.deepEqual(man.manifest("ACT1").remaining, ["A1", "A2"], "the prior authoritative queue is left intact");
  assert.equal(cat.attempt("A1", "ACT1").status, "complete", "the terminal attempt is already durable");
  const r2 = await continueAction("ACT1", ["A1", "A2"], ["A1", "A2"], deps); // storage recovered
  assert.equal(calls.n, 1, "recovery created ZERO new DataDoe exports");
  assert.equal(r2.disposition, "recorded", "the durable terminal attempt is observed and only the manifest transition retried");
  assert.deepEqual(man.manifest("ACT1").remaining, ["A2"], "the queue advances exactly once on recovery");
});

await asyncTest("FIX 2 in-progress (concurrent owner): zero exports, in-progress, queue not falsely changed, and NO racing manifest write is persisted", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  const { calls, fetchCatalog } = countingFetch();
  await cat.claimAttempt("A1", "ACT1"); // a concurrent owner holds the claim
  // The in-progress transition changes nothing durable, so it must NOT write the manifest (a
  // write here would only bump the version and needlessly race the owner's real advance).
  let manifestWrites = 0;
  const saveManifest = (actionId, mf) => { manifestWrites += 1; return man.saveManifest(actionId, mf); };
  const r = await firstClick("ACT1", ["A1", "A2"], dir(["A1", "A2"]), { ...cat, ...man, saveManifest, fetchCatalog });
  assert.equal(calls.n, 0, "zero exports");
  assert.equal(r.status, "in-progress", "the concurrent-owner response is in-progress");
  assert.equal(r.disposition, "in-progress");
  assert.deepEqual(man.manifest("ACT1").remaining, ["A1", "A2"], "the queue is not falsely changed");
  assert.equal(manifestWrites, 1, "only the create wrote the manifest; the in-progress transition persisted nothing");
});

await asyncTest("FIX 2 completion-write failure: an empty-queue completion that cannot persist is NEVER reported complete", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  const saveManifest = () => Promise.reject(new Error("completion write failed"));
  // Seed an in-progress manifest with an already-empty queue; a fixed scope hash lets the request match.
  man.seed("ACT1", { actionId: "ACT1", userId: "admin-1", scopeHash: "SCOPE", primaryAccountIds: [], remaining: [], current: null, status: "in-progress", code: null, createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z" });
  const r = await orchestrateBrandCatalogAction({ actionId: "ACT1", userId: "admin-1", isContinuation: true, clientCursor: [], authorizedPrimaryIds: [], directory: {}, connections: ORCH_CONNS }, { ...cat, ...man, saveManifest, scopeHashOf: () => "SCOPE" });
  assert.notEqual(r.status, "complete", "a completion that cannot persist is never reported complete");
  assert.equal(r.status, "operational-failure", "it degrades to a typed operational state");
  assert.equal(man.manifest("ACT1").status, "in-progress", "the durable manifest was not falsely marked complete");
});

await asyncTest("FIX 2 operational-failure-write failure: a stop that cannot persist is never a false durable stop; the prior queue stays in-progress", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  const { calls, fetchCatalog } = countingFetch();
  const claimAttempt = () => Promise.reject(new Error("claim persistence failed")); // -> disposition operational-failure
  let saves = 0;
  const saveManifest = (actionId, mf) => { saves += 1; if (saves >= 2) return Promise.reject(new Error("stop write failed")); return man.saveManifest(actionId, mf); };
  const r = await firstClick("ACT1", ["A1"], dir(["A1"]), { ...cat, ...man, claimAttempt, saveManifest, fetchCatalog });
  assert.equal(calls.n, 0, "zero exports");
  assert.equal(r.status, "operational-failure", "the response is a typed operational stop");
  assert.equal(man.manifest("ACT1").status, "in-progress", "no durable stop was persisted that could not be saved (prior queue intact)");
});

/* =============== FIX 3: expiry -> explicit terminal transition + 409 =============== */

await asyncTest("FIX 3 expiry: a continuation after the abandon window transitions the action to terminal 'expired' and returns 409 (zero exports)", async () => {
  const cat = makeCatalogStore(); const man = makeManifestStore();
  const { calls, fetchCatalog } = countingFetch();
  man.seed("ACT1", { actionId: "ACT1", userId: "admin-1", scopeHash: "SCOPE", primaryAccountIds: ["A1"], remaining: ["A1"], current: null, status: "in-progress", code: null, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", expiresAt: "2026-06-02T00:00:00.000Z" });
  const r = await orchestrateBrandCatalogAction(
    { actionId: "ACT1", userId: "admin-1", isContinuation: true, clientCursor: ["A1"], authorizedPrimaryIds: ["A1"], directory: {}, connections: ORCH_CONNS },
    { ...cat, ...man, fetchCatalog, scopeHashOf: () => "SCOPE", nowMs: () => Date.parse("2026-08-12T00:00:00.000Z") },
  );
  assert.equal(r.conflict, true, "an abandoned action rejects later continuations with a 409");
  assert.equal(r.code, BRAND_DIRECTORY_ACTION_CONFLICT);
  assert.equal(calls.n, 0, "zero exports");
  assert.equal(man.manifest("ACT1").status, "expired", "the action was transitioned to the terminal 'expired' state (retention then prunes it)");
});

console.log(`\n${passed} assertions passed`);

