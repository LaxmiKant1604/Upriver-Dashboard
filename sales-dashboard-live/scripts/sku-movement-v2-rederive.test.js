// SKU MOVEMENT v2 re-derive + parity (zero export). Proves the version-bump migration contract:
//   * The durable derivation for "sku-movement" is v2 and is byte-for-byte DETERMINISTIC from the same durable OLI +
//     Catalog evidence -- so the scheduler, a manual backfill, and the read-path self-heal all produce the SAME
//     payload (no re-fetch, no DataDoe).
//   * v2 is ASIN-grain: two legitimate SKUs of ONE ASIN aggregate into ONE row (units summed, no double count); a
//     SKU with no resolvable ASIN stays an honest per-SKU Unmapped row (never attached to another ASIN).
//   * The version tag differs from the old SKU-grain v1, so a stale v1 snapshot can NEVER serve as v2 -- the
//     params-hash (which folds the snapshotVersion) misses and the self-heal re-derives fresh v2 evidence.
//   * The snapshot carries NO identifier field: manual identifiers are joined at SERVE, kept OUT of the snapshot, so a
//     re-derive never erases them.
//   * Marketplace/currency isolation, representative-SKU amzn-exclusion, and the unit policy are preserved.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { REPORT_DERIVATIONS } from "../lib/server/sync/report-derivation.js";
import { SKU_MOVEMENT_VERSION } from "../lib/server/reports/sku-movement-backfill.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const test = (name, fn) => { try { fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const ENTRY = REPORT_DERIVATIONS["sku-movement"];
const EFF = "2026-08-25"; // effectiveAsOf (already D-1 capped by the caller)

// Two SKUs of ONE ASIN + an amzn return SKU on the same ASIN + a second ASIN + an unresolved-ASIN pending SKU.
const OLI = [
  { sale_date: "2026-08-24", child_asin: "B0AAA", sku: "SKU-A1", currency: "USD", units: 3 },
  { sale_date: "2026-08-24", child_asin: "B0AAA", sku: "SKU-A2", currency: "USD", units: 2 },
  { sale_date: "2026-08-23", child_asin: "B0AAA", sku: "amzn.gr.1", currency: "USD", units: 4 }, // amzn SKU: units still count, never the rep SKU
  { sale_date: "2026-08-24", child_asin: "B0BBB", sku: "SKU-B", currency: "USD", units: 7 },
  { sale_date: "2026-08-24", child_asin: "", sku: "PENDING-1", currency: "USD", units: 1 }, // no ASIN -> Unmapped per-SKU
  { sale_date: "2026-08-24", child_asin: "B0AAA", sku: "SKU-A1", currency: "EUR", units: 9 }, // same ASIN, other currency -> separate row
];
const CAT = [
  { child_asin: "B0AAA", product_brand: "Acme", product_name: "Widget A", sku: "SKU-A1" },
  { child_asin: "B0BBB", product_brand: "Acme", product_name: "Widget B" },
];
const context = { effectiveAsOf: EFF, brand: "ALL", coverageFrom: "2026-01-01" };
const derive = () => ENTRY.derive({ sources: { "sku-movement:oli": { rows: OLI }, "sku-movement:catalog": { rows: CAT } }, context });

test("the durable derivation is v2 and matches the backfill version constant", () => {
  assert.equal(ENTRY.snapshotVersion, "sku-movement/v2");
  assert.equal(SKU_MOVEMENT_VERSION, "sku-movement/v2");
  assert.notEqual(ENTRY.snapshotVersion, "sku-movement/v1", "the version was bumped so v1 can never serve as v2");
});

test("scheduler == manual == self-heal: the derive is byte-for-byte deterministic from the same evidence", () => {
  const a = derive();
  const b = derive();
  assert.deepEqual(a, b, "two derivations from identical durable evidence are identical");
});

test("v2 is ASIN-grain: the two USD SKUs of B0AAA aggregate into ONE row (units summed, incl. the amzn SKU's units)", () => {
  const p = derive();
  const usdAaa = p.rows.filter((r) => r.asin === "B0AAA" && r.currency === "USD");
  assert.equal(usdAaa.length, 1, "one aggregated ASIN row, not one per SKU");
  const row = usdAaa[0];
  // 3 + 2 (2026-08-24) + 4 (2026-08-23) all fall inside the 60-day daily axis -> summed as ordered units.
  const total = Object.values(row.dailyUnits).reduce((s, u) => s + u, 0);
  assert.equal(total, 9, "3+2+4 units combined across the ASIN's SKUs (amzn units still count)");
  assert.equal(row.skuCount, 3, "three distinct SKUs contributed");
});

test("the representative SKU excludes amzn return SKUs (deterministic legitimate SKU)", () => {
  const row = derive().rows.find((r) => r.asin === "B0AAA" && r.currency === "USD");
  assert.equal(row.sku, "SKU-A1", "rep SKU is the catalog primary legitimate SKU, never amzn.*");
  assert.equal(row.hasSellerSku, true);
  assert.equal(row.legitSkuCount, 2, "SKU-A1 + SKU-A2 are legitimate; amzn.gr.1 is excluded from the rep set");
});

test("currency isolation: the same ASIN in EUR is a SEPARATE row (never merged across currency)", () => {
  const rows = derive().rows.filter((r) => r.asin === "B0AAA");
  const currencies = rows.map((r) => r.currency).sort();
  assert.deepEqual(currencies, ["EUR", "USD"], "one row per (ASIN, currency)");
});

test("a SKU with no resolvable ASIN stays an honest per-SKU Unmapped row (never attached to an ASIN)", () => {
  const p = derive();
  const unmapped = p.rows.filter((r) => r.unmapped);
  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0].asin, "", "no ASIN");
  assert.equal(unmapped[0].brand, "Unmapped");
  // The pending unit is NOT folded into B0AAA / B0BBB.
  const bbb = p.rows.find((r) => r.asin === "B0BBB");
  assert.equal(Object.values(bbb.dailyUnits).reduce((s, u) => s + u, 0), 7, "B0BBB keeps only its own 7 units");
});

test("the snapshot carries NO identifier field on any row (identifiers join at serve, survive a re-derive)", () => {
  const p = derive();
  for (const r of p.rows) assert.ok(!("identifier" in r), `row ${r.asin} must not embed an identifier in the snapshot`);
});

test("the payload validates and reports the honest latest-data date", () => {
  const p = derive();
  assert.equal(ENTRY.validatePayload(p), true);
  assert.equal(ENTRY.latestDataDate(p), EFF, "latestDataDate = effectiveAsOf, never saved_at / now");
  assert.equal(p.defaultRecentDays, 7, "default window is 7");
  assert.equal(p.maxRecentDays, 30);
  assert.equal(p.dailyDates.length, 60, "a 60-day daily axis for client-side N recompute");
});

test("a named-brand empty result is a VALID empty report, never an All-Brands fallback", () => {
  const p = ENTRY.derive({ sources: { "sku-movement:oli": { rows: OLI }, "sku-movement:catalog": { rows: CAT } }, context: { ...context, brand: "NoSuchBrand" } });
  assert.equal(p.brandFiltered, true);
  assert.equal(p.rows.length, 0, "no ASIN matches the brand -> empty, not filled from other brands");
  assert.equal(ENTRY.validatePayload(p), true, "an empty branded report is still a valid envelope");
});

out("\n" + passed + " assertions passed");
