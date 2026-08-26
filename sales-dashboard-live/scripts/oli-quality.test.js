// OLI DATA-QUALITY indicator -- deterministic OFFLINE proof that the explicit-zero notice keeps the three OLI
// classes strictly separate (cancelled / explicit-zero / NULL-missing), never touches business Sales/Units, scopes
// by brand through the Catalog map only, and isolates account/date/currency. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeSync } from "node:fs";
import { summarizeExplicitZeroOli, brandByAsinFromCatalog } from "../lib/server/reports/oli-quality.js";
import { FULFILLMENT_CATEGORY } from "../lib/server/sync/oli-order-rules.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const test = (name, fn) => { try { fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const CAT = [{ child_asin: "B0A", product_brand: "Acme" }, { child_asin: "B0B", product_brand: "Bolt" }];
// A dimensional grain row as the reader returns it (explicit-zero rows: is_cancelled false, value present 0, units>0).
const r = (over = {}) => ({ sale_date: "2026-08-10", sku: "SKU-A", child_asin: "B0A", currency: "INR", amazon_order_status: "Shipped", fulfillment_channel: "AFN", address_state: "MH", address_city: "Pune", total_units_sum: 2, is_cancelled: false, total_sales_sum: 0, ...over });

test("1. cancelled row is never in the explicit-zero indicator (defence in depth)", () => {
  const s = summarizeExplicitZeroOli([r({ is_cancelled: true, total_sales_sum: 0, total_units_sum: 5 })], { catalogRows: CAT });
  assert.equal(s.totalUnits, 0);
  assert.equal(s.rowCount, 0);
});

test("2. non-cancelled explicit-zero row IS in the indicator (and never business)", () => {
  const s = summarizeExplicitZeroOli([r({ total_sales_sum: 0, total_units_sum: 3 })], { catalogRows: CAT });
  assert.equal(s.totalUnits, 3);
  assert.equal(s.rowCount, 1);
  assert.equal(s.breakdown[0].units, 3);
  assert.equal(s.breakdown[0].fulfillment, FULFILLMENT_CATEGORY.AMAZON, "AFN normalized to Amazon/FBA");
});

test("3. non-cancelled NULL-value row is NEVER in the explicit-zero indicator (a different, missing class)", () => {
  const s = summarizeExplicitZeroOli([r({ total_sales_sum: null, total_units_sum: 4 })], { catalogRows: CAT });
  assert.equal(s.totalUnits, 0, "NULL/missing is not explicit-zero");
});

test("4. positive-value row is never in the indicator", () => {
  const s = summarizeExplicitZeroOli([r({ total_sales_sum: 100, total_units_sum: 2 })], { catalogRows: CAT });
  assert.equal(s.totalUnits, 0);
});

test("5. mixed rows -> exact separate counts, no double counting the grain", () => {
  const s = summarizeExplicitZeroOli([
    r({ sku: "SKU-A", total_sales_sum: 0, total_units_sum: 2 }),
    r({ sku: "SKU-A", total_sales_sum: 0, total_units_sum: 3 }), // same grain -> merges rows+units
    r({ sku: "SKU-Z", total_sales_sum: 0, total_units_sum: 1 }), // different grain
    r({ total_sales_sum: 50, total_units_sum: 9 }),               // positive -> excluded
    r({ is_cancelled: true, total_units_sum: 9 }),                // cancelled -> excluded
  ], { catalogRows: CAT });
  assert.equal(s.totalUnits, 6, "2 + 3 + 1 explicit-zero units only");
  assert.equal(s.rowCount, 3, "three explicit-zero grain rows");
  const skuA = s.breakdown.find((b) => b.sku === "SKU-A");
  assert.equal(skuA.rows, 2);
  assert.equal(skuA.units, 5, "same grain merged");
});

test("8. named brand attributes ONLY catalog-mapped child_asin rows", () => {
  const rows = [r({ child_asin: "B0A", total_units_sum: 2 }), r({ child_asin: "B0B", sku: "SKU-B", total_units_sum: 7 })];
  const acme = summarizeExplicitZeroOli(rows, { catalogRows: CAT, brand: "Acme" });
  assert.equal(acme.totalUnits, 2, "only B0A -> Acme");
  const bolt = summarizeExplicitZeroOli(rows, { catalogRows: CAT, brand: "Bolt" });
  assert.equal(bolt.totalUnits, 7, "only B0B -> Bolt");
});

test("9. an UNMAPPED child_asin never leaks into a selected brand (but shows under ALL)", () => {
  const rows = [r({ child_asin: "B0X", sku: "SKU-X", total_units_sum: 5 })]; // B0X not in catalog
  assert.equal(summarizeExplicitZeroOli(rows, { catalogRows: CAT, brand: "Acme" }).totalUnits, 0, "unmapped never attributed to Acme");
  assert.equal(summarizeExplicitZeroOli(rows, { catalogRows: CAT, brand: "ALL" }).totalUnits, 5, "but it IS visible under ALL");
});

test("10. currency stays isolated (never merged across currencies)", () => {
  const rows = [r({ currency: "INR", total_units_sum: 2 }), r({ currency: "USD", total_units_sum: 3 })];
  const s = summarizeExplicitZeroOli(rows, { catalogRows: CAT });
  assert.equal(s.totalUnits, 5);
  assert.deepEqual(s.currencies.sort(), ["INR", "USD"]);
  assert.equal(s.breakdown.length, 2, "two grains: never merged across currency");
});

test("11. STRUCTURAL: the indicator never reads or emits the retired unpriced_units field", () => {
  const src = readFileSync(new URL("../lib/server/reports/oli-quality.js", import.meta.url), "utf8");
  assert.ok(!/unpriced_units/.test(src), "oli-quality.js must never reference unpriced_units");
  const s = summarizeExplicitZeroOli([r({ total_sales_sum: 0, total_units_sum: 2 })], { catalogRows: CAT });
  assert.ok(!("unpriced_units" in s.breakdown[0]), "breakdown rows never carry unpriced_units");
});

test("6/7. STRUCTURAL: the reader isolates by exact account + date range (getExplicitZeroOliUnits query)", () => {
  const src = readFileSync(new URL("../lib/server/supabase.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export async function getExplicitZeroOliUnits"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(/account_id: `eq\.\$\{accountId\}`/.test(body), "reader filters by the EXACT account id");
  assert.ok(/sale_date: `gte\.\$\{from\}`/.test(body) && /`lte\.\$\{to\}`/.test(body), "reader filters the date range");
  assert.ok(/is_cancelled: "eq\.false"/.test(body), "reader excludes cancelled");
  assert.ok(/total_sales_sum: "eq\.0"/.test(body), "reader takes ONLY present-zero (not NULL)");
  assert.ok(/total_units_sum: "gt\.0"/.test(body), "reader takes only positive units");
  assert.ok(!/amazon_order_id|address_country/.test(body), "reader never requests amazon_order_id / address_country");
});

test("15. Indya-shaped production regression: explicit-zero units surface, business excluded", () => {
  // Indya (large IN account) had explicit-zero promotional units on assorted SKUs -- they show in the indicator
  // (audit), never in Sales/Units.
  const rows = Array.from({ length: 12 }, (_v, i) => r({ sku: "IND-" + (i % 4), child_asin: "B0A", total_sales_sum: 0, total_units_sum: 1 }));
  const s = summarizeExplicitZeroOli(rows, { catalogRows: CAT, brand: "Acme" });
  assert.equal(s.totalUnits, 12, "all explicit-zero units surfaced");
  assert.equal(s.breakdown.length, 4, "merged to 4 SKU grains");
  assert.equal(brandByAsinFromCatalog(CAT).get("B0A"), "Acme");
});

out("\n" + passed + " assertions passed");
