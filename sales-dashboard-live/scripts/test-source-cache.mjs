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
import { buildBrandSalesPayload } from "../api/datadoe.js";

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

await asyncTest("a successful ZERO-ROW Product Catalog is unavailable for brand mapping: no fabricated brands or zeros", async () => {
  const originalFetch = global.fetch;
  const sourceByExport = new Map();
  let creates = 0;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/exports") && options.method === "POST") {
      creates += 1;
      const id = `bs-${creates}`;
      sourceByExport.set(id, JSON.parse(options.body).sourceId);
      return new Response(JSON.stringify({ id, status: "COMPLETED" }), { status: 200 });
    }
    const raw = target.match(/\/exports\/(bs-\d+)\/raw$/);
    if (raw) {
      const sourceId = sourceByExport.get(raw[1]);
      // The Product Catalog (short id) returns ZERO rows; Order Line Items returns real sales.
      const rows = sourceId === PRODUCT_CATALOG_SHORT_ID
        ? []
        : [{ date: "2026-08-01", child_asin: "A1", seller_or_vendor_id: "S1", seller_or_vendor_name: "Seller", marketplace_country_code: "US", item_price_currency: "USD", total_sales_sum: 100, total_units_sold_sum: 5 }];
      return new Response(JSON.stringify({ rawContent: JSON.stringify(rows) }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${target}`);
  };
  try {
    const payload = await buildBrandSalesPayload({ apiKey: "dd_api_test", ids: ["req6-acct"], from: "2026-07-01", to: "2026-08-01" });
    assert.deepEqual(payload.asinBrand, {}, "an empty catalog yields NO ASIN->brand mapping (brand mapping unavailable)");
    assert.deepEqual(payload.catalogBrands, [], "no fabricated brand: the 'Unassigned' placeholder is never surfaced as a brand");
    assert.equal(payload.rows.length, 1, "the real order sales are preserved, not dropped");
    assert.equal(payload.rows[0].total_sales, 100, "sales stay honest, never fabricated as zero");
    assert.equal(payload.rows[0].product_brand, "Unassigned", "an unmapped sale is bucketed as Unassigned, which is not a real brand");
    const usedIds = [...sourceByExport.values()];
    assert.ok(usedIds.includes(PRODUCT_CATALOG_SHORT_ID), "the catalog export used the short live source id");
    assert.ok(!usedIds.includes(PRODUCT_CATALOG_OBSOLETE_LONG_ID), "the obsolete long id is never posted, even after a zero-row result (no fallback)");
  } finally {
    global.fetch = originalFetch;
  }
});

console.log(`\n${passed} assertions passed`);

