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
  BRAND_CATALOG_BATCH_SIZE,
  SAFE_CATALOG_CODES,
  CATALOG_SOURCE_UNAVAILABLE,
  CATALOG_EMPTY,
  CATALOG_TRUNCATED,
  CATALOG_FETCH_FAILED,
} from "../api/datadoe.js";

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

// A tiny in-memory catalog snapshot store so the LKG/typed-code policy is exercised
// end to end without Supabase. `getPriorSnapshot` reads it; `saveSnapshot` writes it.
function makeCatalogStore(seed = {}) {
  const byAccount = new Map(Object.entries(seed));
  const saves = [];
  return {
    saves,
    getPriorSnapshot: (accountId) => Promise.resolve(byAccount.get(String(accountId)) || null),
    saveSnapshot: (accountId, payload) => { saves.push({ accountId: String(accountId), payload }); byAccount.set(String(accountId), { payload }); return Promise.resolve(); },
    snapshot: (accountId) => byAccount.get(String(accountId)) || null,
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
  const fetched = [];
  await syncBrandCatalogBatch(batch, [PRIMARY], {
    getPriorSnapshot: () => Promise.resolve(null), saveSnapshot: () => Promise.resolve(),
    // Simulate a SLOW export: even if this took ~45s, only A1 is touched this invocation.
    fetchCatalog: ({ rawAccountId }) => { fetched.push(rawAccountId); return [{ child_asin: "X", product_brand: "Acme" }]; },
  });
  assert.deepEqual(fetched, ["A1"], "the slow export touched only A1; A2/A3 were never fetched this request");
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
  const result = await syncAccountBrandCatalog(acct("A1"), {
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

await asyncTest("a prior SUCCESSFUL catalog snapshot survives a later 404 / timeout / truncation / empty / unusable refresh (LKG preserved)", async () => {
  const good = { payload: { catalogBrands: ["Bebi Born", "Nordfell"], catalogSyncStatus: "complete", catalogSyncedAt: "2026-08-10T00:00:00.000Z" } };
  const failures = [
    { label: "404", fetchCatalog: () => { throw new Error("DataDoe export creation failed (404): Source not found"); } },
    { label: "timeout", fetchCatalog: () => { throw new Error("DataDoe export timed out while processing."); } },
    { label: "truncation", fetchCatalog: () => new Array(10000).fill({ child_asin: "A", product_brand: "B" }) },
    { label: "empty", fetchCatalog: () => [] },
    { label: "unusable", fetchCatalog: () => [{ child_asin: "", product_brand: "" }, { child_asin: "A", product_brand: "" }] },
  ];
  for (const f of failures) {
    const store = makeCatalogStore({ A1: good });
    const result = await syncAccountBrandCatalog({ ...acct("A1"), actionId: "ACT1" }, { ...store, fetchCatalog: f.fetchCatalog });
    assert.equal(result.status, "unavailable", `${f.label}: reported unavailable`);
    assert.equal(result.preservedLkg, true, `${f.label}: last-known-good is preserved`);
    const snap = store.snapshot("A1").payload;
    assert.deepEqual(snap.catalogBrands, ["Bebi Born", "Nordfell"], `${f.label}: the prior brand map is still readable (never replaced)`);
    assert.equal(snap.catalogSyncStatus, "complete", `${f.label}: the map stays complete (LKG not downgraded)`);
    // The typed failure is RECORDED on the snapshot (for idempotency + cumulative summary),
    // but only as an attempt -- the brand map itself is untouched, and no raw error is stored.
    assert.equal(snap.catalogAttemptStatus, "unavailable");
    assert.ok(SAFE_CATALOG_CODES.has(snap.catalogAttemptCode), `${f.label}: typed attempt code recorded`);
    assert.equal(snap.catalogSyncError, undefined, `${f.label}: no raw error persisted`);
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
  // Mirror the handler's summary predicate: an account is a this-action failure if its
  // latest attempt under this action failed, whether its map is a preserved LKG or absent.
  const summaryFor = (store, ids, actionId) => ids.filter((id) => {
    const p = store.snapshot(id)?.payload;
    if (!p) return false;
    if (p.catalogSyncStatus === "unavailable") return true; // no usable saved catalog
    return p.catalogAttemptActionId === actionId && p.catalogAttemptStatus === "unavailable"; // LKG-preserved failure
  });
  const store = makeCatalogStore({ A1: { payload: { catalogBrands: ["Bebi Born"], catalogSyncStatus: "complete", catalogSyncedAt: "2026-08-10T00:00:00.000Z" } } });
  // Batch 1: A1 (has LKG) fails 404 -> LKG preserved, failure recorded.
  await syncAccountBrandCatalog({ ...acct("A1"), actionId: "ACT1" }, { ...store, fetchCatalog: () => { throw new Error("DataDoe export creation failed (404): Source not found"); } });
  assert.deepEqual(summaryFor(store, ["A1", "A2"], "ACT1"), ["A1"], "A1's failure is in the summary after batch 1");
  // Batch 2: A2 succeeds. Re-reading A1's (still complete) snapshot must NOT drop A1's earlier failure.
  await syncAccountBrandCatalog({ ...acct("A2"), actionId: "ACT1" }, { ...store, fetchCatalog: () => [{ child_asin: "A2x", product_brand: "Nordfell" }] });
  assert.equal(store.snapshot("A1").payload.catalogSyncStatus, "complete", "A1's LKG map is still readable");
  assert.deepEqual(summaryFor(store, ["A1", "A2"], "ACT1"), ["A1"], "A1's early-batch LKG-preserved failure STILL appears in the final summary");
});

await asyncTest("mixed outcome: a successful account updates its map; a failed account with no prior success saves a typed-unavailable marker (no fabricated brands)", async () => {
  const store = makeCatalogStore();
  const results = await syncBrandCatalogBatch(["GOOD", "BAD"], [PRIMARY], {
    getPriorSnapshot: store.getPriorSnapshot,
    saveSnapshot: store.saveSnapshot,
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
    getPriorSnapshot: store.getPriorSnapshot,
    saveSnapshot: store.saveSnapshot,
    fetchCatalog: ({ rawAccountId }) => { attempted.push(rawAccountId); return [{ child_asin: "X", product_brand: "Acme" }]; },
  });
  assert.deepEqual(attempted.sort(), ["A1", "A2"], "only primary accounts reached DataDoe; the dd-secondary id was skipped");
  assert.ok(!results.some((r) => String(r.accountId).startsWith("dd-secondary:")), "no dd-secondary result was produced");
});

console.log(`\n${passed} assertions passed`);

