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

console.log(`\n${passed} assertions passed`);

