// Tests for the pure logic of the flexii OLI historical-restore release script, plus a static regression guard
// that the DataDoe-confirmed 50,000 OLI ceiling stays consistent across every mirrored constant. No DB, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  planRestore, classifyFetchResult, validateFragment, unitRowsToSnake, isDateStr, RESTORE_DEFAULTS,
} from "./release/flexii-oli-history-restore.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OLI_GROUP_BY = ["date", "seller_or_vendor_id", "sku", "child_asin", "item_price_currency", "amazon_order_status", "fulfillment_channel", "address_state", "address_city", "amazon_order_id", "item_status"];
const SELLER = "f08cefca-c527-41d6-a2e7-71a435478f5d";
const row = (over = {}) => ({
  date: "2025-06-01", seller_or_vendor_id: SELLER, sku: "SKU-1", child_asin: "B001", item_price_currency: "GBP",
  amazon_order_status: "Shipped", fulfillment_channel: "AFN", address_state: "London", address_city: "London",
  amazon_order_id: "111-0000001-0000001", item_status: "Shipped", total_sales_sum: 10, total_units_sum: 1, ...over,
});

/* ---------------- planRestore ---------------- */

test("planRestore: default window plans ONE export / 2-token ceiling and preserves the 2026-09-03 boundary", () => {
  const p = planRestore({ from: RESTORE_DEFAULTS.from, to: RESTORE_DEFAULTS.to });
  assert.equal(p.windows.length, 1);
  assert.deepEqual(p.windows[0], { from: "2025-01-01", to: "2026-09-02" });
  assert.equal(p.sellerCount, 1);
  assert.equal(p.limit, 50000);
  assert.equal(p.expectedExports, 1);
  assert.equal(p.expectedTokens, 2);
  assert.equal(p.tokenCeiling, 2);
  assert.equal(p.preserveFrom, "2026-09-03");
});

test("planRestore: refuses a coveredTo that would delete the preserved 2026-09-03+ history", () => {
  assert.throws(() => planRestore({ from: "2025-01-01", to: "2026-09-03" }), /strictly before the preserved boundary/);
  assert.throws(() => planRestore({ from: "2025-01-01", to: "2026-12-31" }), /strictly before the preserved boundary/);
});

test("planRestore: rejects an inverted or malformed window", () => {
  assert.throws(() => planRestore({ from: "2026-09-02", to: "2025-01-01" }), /is after/);
  assert.throws(() => planRestore({ from: "not-a-date", to: "2026-09-02" }), /ISO from\/to/);
});

/* ---------------- classifyFetchResult (truncation) ---------------- */

test("classifyFetchResult: a result AT the 50,000 cap is truncated; below is complete", () => {
  assert.equal(classifyFetchResult({ rowCount: 0 }), "complete");
  assert.equal(classifyFetchResult({ rowCount: 49999 }), "complete");
  assert.equal(classifyFetchResult({ rowCount: 50000 }), "truncated");
  assert.equal(classifyFetchResult({ rowCount: 50001 }), "truncated");
  assert.throws(() => classifyFetchResult({ rowCount: -1 }), /non-negative/);
});

/* ---------------- validateFragment ---------------- */

test("validateFragment: a clean single-seller GBP in-range fragment validates and totals correctly", () => {
  const rows = [row({ date: "2025-06-01", total_sales_sum: 10, total_units_sum: 1 }), row({ date: "2026-09-02", sku: "SKU-2", total_sales_sum: 5.5, total_units_sum: 2 })];
  const v = validateFragment({ rows, expectedSeller: SELLER, expectedCurrency: "GBP", from: "2025-01-01", to: "2026-09-02", groupByColumns: OLI_GROUP_BY });
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
  assert.equal(v.earliest, "2025-06-01");
  assert.equal(v.latest, "2026-09-02");
  assert.equal(v.salesSum, 15.5);
  assert.equal(v.unitsInt, 3);
  assert.equal(v.dupes, 0);
});

test("validateFragment: flags a foreign seller", () => {
  const rows = [row(), row({ seller_or_vendor_id: "deadbeef-0000" })];
  const v = validateFragment({ rows, expectedSeller: SELLER, expectedCurrency: "GBP", from: "2025-01-01", to: "2026-09-02", groupByColumns: OLI_GROUP_BY });
  assert.equal(v.ok, false);
  assert.match(v.errors.join(" "), /unexpected seller/);
});

test("validateFragment: flags a non-GBP currency", () => {
  const rows = [row({ item_price_currency: "USD" })];
  const v = validateFragment({ rows, expectedSeller: SELLER, expectedCurrency: "GBP", from: "2025-01-01", to: "2026-09-02", groupByColumns: OLI_GROUP_BY });
  assert.equal(v.ok, false);
  assert.match(v.errors.join(" "), /unexpected currency/);
});

test("validateFragment: flags a row-date outside the requested window (incl. a leaked 2026-09-03 tail date)", () => {
  const rows = [row({ date: "2026-09-03" })];
  const v = validateFragment({ rows, expectedSeller: SELLER, expectedCurrency: "GBP", from: "2025-01-01", to: "2026-09-02", groupByColumns: OLI_GROUP_BY });
  assert.equal(v.ok, false);
  assert.equal(v.outOfRange, 1);
  assert.match(v.errors.join(" "), /outside/);
});

test("validateFragment: flags canonical-grain duplicates", () => {
  const rows = [row(), row()]; // identical grain
  const v = validateFragment({ rows, expectedSeller: SELLER, expectedCurrency: "GBP", from: "2025-01-01", to: "2026-09-02", groupByColumns: OLI_GROUP_BY });
  assert.equal(v.ok, false);
  assert.equal(v.dupes, 1);
  assert.match(v.errors.join(" "), /duplicate/);
});

test("validateFragment: an empty fragment is NOT ok (inconclusive, never persisted as proven-zero)", () => {
  const v = validateFragment({ rows: [], expectedSeller: SELLER, expectedCurrency: "GBP", from: "2025-01-01", to: "2026-09-02", groupByColumns: OLI_GROUP_BY });
  assert.equal(v.ok, false);
  assert.match(v.errors.join(" "), /empty fragment/);
});

/* ---------------- unitRowsToSnake ---------------- */

test("unitRowsToSnake: maps camelCase operational-unit rows to the RPC's snake_case jsonb (null priced_sales preserved)", () => {
  const out = unitRowsToSnake([
    { sellerOrVendorId: SELLER, saleDate: "2025-06-01", sku: "SKU-1", childAsin: "B001", currency: "GBP", pricedUnits: 3, pricedSales: 30, explicitZeroUnits: 0, pendingUnits: 1, cancelledUnits: 2, sourceRequestHash: "h" },
    { sellerOrVendorId: SELLER, saleDate: "2025-06-02", sku: "SKU-2", childAsin: "B002", currency: "GBP", pricedUnits: 0, pricedSales: null, explicitZeroUnits: 4, pendingUnits: 0, cancelledUnits: 0, sourceRequestHash: "h" },
  ]);
  assert.equal(out[0].seller_or_vendor_id, SELLER);
  assert.equal(out[0].sale_date, "2025-06-01");
  assert.equal(out[0].child_asin, "B001");
  assert.equal(out[0].priced_units, 3);
  assert.equal(out[0].priced_sales, 30);
  assert.equal(out[0].explicit_zero_units, 0);
  assert.equal(out[0].pending_units, 1);
  assert.equal(out[0].cancelled_units, 2);
  assert.equal(out[0].source_request_hash, "h");
  assert.equal(out[1].priced_sales, null); // never coerced to 0
  assert.equal(unitRowsToSnake(null), null);
});

test("isDateStr sanity", () => {
  assert.equal(isDateStr("2025-06-01"), true);
  assert.equal(isDateStr("2025-6-1"), false);
  assert.equal(isDateStr(""), false);
  assert.equal(isDateStr(null), false);
});

/* ---------------- static regression guard: the 50,000 OLI ceiling across every mirror ---------------- */

test("STATIC GUARD: the OLI 50,000 ceiling is consistent across every mirrored constant (no regression to 5,000)", () => {
  const has = (rel, re) => assert.match(readFileSync(join(ROOT, rel), "utf8"), re, rel);
  // scheduler contract
  has("lib/server/sync/report-source-contracts.js", /const OLI_SALES_ROW_LIMIT = 50000;/);
  // live REST mirrors
  has("api/datadoe.js", /const OLI_SALES_ROW_LIMIT = 50000;/);
  has("api/datadoe.js", /const ORDER_SALES_ROW_LIMIT = 50000;/);
  has("api/datadoe.js", /const DAILY_BRAND_ROW_LIMIT = 50000;/);
  // reports layer
  has("lib/server/reports/sources.js", /export const OLI_ROW_LIMIT = 50000;/);
  // and NONE of them still reads 5000 for OLI
  const contracts = readFileSync(join(ROOT, "lib/server/sync/report-source-contracts.js"), "utf8");
  assert.doesNotMatch(contracts, /OLI_SALES_ROW_LIMIT = 5000;/);
});
