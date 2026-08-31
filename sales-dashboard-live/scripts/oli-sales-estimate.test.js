// OLI SALES ESTIMATE ENGINE tests -- the pure matching/estimation + enrichment logic that fills missing/zero-price
// OLI sales from same-product historical prices. Proves every mandatory rule with ZERO I/O.
//
// 7-bit ASCII, LF, no top-level await, synchronous progress. Dynamic imports after a dummy Supabase env.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const START = Date.now();
const mark = (m) => { try { writeSync(2, "[+" + (Date.now() - START) + "ms] " + m + "\n"); } catch (_e) { /* ignore */ } };
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let ENG;

const ACC = "acct-1";
const SELLER = "SELLER1";
// A priced dimensional REFERENCE row (non-cancelled, positive value + units).
const ref = (date, unitPrice, units = 1, over = {}) => ({
  seller_or_vendor_id: SELLER, sale_date: date, sku: "SKU-A", child_asin: "B0ASIN", currency: "INR",
  is_cancelled: false, total_sales_sum: unitPrice * units, total_units_sum: units, source_request_hash: "hash-" + date, ...over,
});
// A target OPERATIONAL row with `missing` non-cancelled units carrying no positive price (pending + explicit-zero).
const target = (date, missing, over = {}) => ({
  account_id: ACC, seller_or_vendor_id: SELLER, sale_date: date, sku: "SKU-A", child_asin: "B0ASIN", currency: "INR",
  priced_units: 0, explicit_zero_units: 0, pending_units: missing, cancelled_units: 0, source_request_hash: "op-" + date, ...over,
});
const only = (r) => { assert.equal(r.estimates.length + r.unresolved.length >= 0, true); return r; };

async function main() {
  mark("loading oli-sales-estimate");
  ENG = await import("../lib/server/sync/oli-sales-estimate.js");
  mark("running " + tests.filter((t) => !t.marker).length + " tests");
  let failures = 0;
  for (const t of tests) {
    if (t.marker) { mark("group -> " + t.marker); continue; }
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (err) { failures += 1; out("FAIL  " + t.name); out(String(err && err.stack ? err.stack : err)); }
  }
  out("\n" + passed + " assertions passed");
  mark("done: " + passed + " passed, " + failures + " failed");
  return failures;
}

// ---------------------------------------------------------------------------------------------------------------
group("computeOliSalesEstimates: reference search order + median + multiplication");

test("same-day exact match wins (uses today's own priced rows before any prior date)", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [target("2026-08-29", 3)],
    referenceRows: [ref("2026-08-29", 100), ref("2026-08-28", 999)],
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 1);
  assert.equal(r.estimates[0].referenceDate, "2026-08-29");
  assert.equal(r.estimates[0].referenceUnitPrice, 100);
  assert.equal(r.estimates[0].estimatedSales, 300); // 100 x 3
  assert.equal(r.estimates[0].matchingMethod, ENG.MATCH_SKU_EXACT);
  assert.equal(r.estimates[0].targetQuantity, 3);
});

test("nearest PRIOR date precedence (no same-day -> D-1 before D-3)", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [target("2026-08-29", 2)],
    referenceRows: [ref("2026-08-28", 50), ref("2026-08-26", 999)],
    calculatedAt: "T",
  });
  assert.equal(r.estimates[0].referenceDate, "2026-08-28");
  assert.equal(r.estimates[0].estimatedSales, 100); // 50 x 2
});

test("maximum SEVEN-day lookback: D-7 is used; D-8 is NOT", () => {
  const found = ENG.computeOliSalesEstimates({ accountId: ACC, accountMarketplace: "IN", operationalRows: [target("2026-08-29", 1)], referenceRows: [ref("2026-08-22", 70)], calculatedAt: "T" });
  assert.equal(found.estimates.length, 1);
  assert.equal(found.estimates[0].referenceDate, "2026-08-22"); // exactly 7 days back
  const tooOld = ENG.computeOliSalesEstimates({ accountId: ACC, accountMarketplace: "IN", operationalRows: [target("2026-08-29", 1)], referenceRows: [ref("2026-08-21", 70)], calculatedAt: "T" });
  assert.equal(tooOld.estimates.length, 0, "D-8 is beyond the 7-day horizon");
  assert.equal(tooOld.unresolved.length, 1);
});

test("NEVER a future-date reference (a later-dated priced row is ignored)", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [target("2026-08-29", 1)],
    referenceRows: [ref("2026-08-30", 100), ref("2026-08-31", 100)],
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 0, "future prices are never used");
  assert.equal(r.unresolved.length, 1);
});

test("MEDIAN unit price across multiple valid matches on the chosen date", () => {
  // three references on the same date with unit prices 10, 30, 50 -> median 30
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [target("2026-08-29", 4)],
    referenceRows: [ref("2026-08-29", 10), ref("2026-08-29", 50, 1, { fulfillment: "b" }), ref("2026-08-29", 30, 1, { fulfillment: "c" })],
    calculatedAt: "T",
  });
  assert.equal(r.estimates[0].referenceUnitPrice, 30);
  assert.equal(r.estimates[0].estimatedSales, 120); // 30 x 4
});

test("unit price is item_price_value / quantity (not the raw value)", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [target("2026-08-29", 2)],
    referenceRows: [ref("2026-08-29", 25, 4)], // total 100 over 4 units -> unit price 25
    calculatedAt: "T",
  });
  assert.equal(r.estimates[0].referenceUnitPrice, 25);
  assert.equal(r.estimates[0].estimatedSales, 50); // 25 x 2
});

test("target quantity = explicit_zero_units + pending_units", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [target("2026-08-29", 0, { explicit_zero_units: 2, pending_units: 3 })],
    referenceRows: [ref("2026-08-29", 10)],
    calculatedAt: "T",
  });
  assert.equal(r.estimates[0].targetQuantity, 5);
  assert.equal(r.estimates[0].estimatedSales, 50);
});

// ---------------------------------------------------------------------------------------------------------------
group("computeOliSalesEstimates: SKU fallback ONLY when target SKU is blank");

test("target WITH a SKU never uses the ASIN-only fallback (a different-SKU same-ASIN price is not used)", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [target("2026-08-29", 1, { sku: "SKU-A" })],
    referenceRows: [ref("2026-08-29", 100, 1, { sku: "SKU-OTHER" })], // same ASIN, different SKU
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 0, "same-ASIN different-SKU is NOT a match when the target has a SKU");
  assert.equal(r.unresolved.length, 1);
});

test("target with a BLANK SKU uses the controlled ASIN-only fallback (same account/seller/currency/ASIN)", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [target("2026-08-29", 2, { sku: "" })],
    referenceRows: [ref("2026-08-29", 40, 1, { sku: "SKU-X" }), ref("2026-08-29", 60, 1, { sku: "SKU-Y" })],
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 1);
  assert.equal(r.estimates[0].matchingMethod, ENG.MATCH_ASIN_FALLBACK);
  assert.equal(r.estimates[0].referenceUnitPrice, 50); // median(40,60)
  assert.equal(r.estimates[0].estimatedSales, 100);
});

test("blank-SKU target matches a blank-SKU reference too (ASIN key ignores SKU)", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [target("2026-08-29", 1, { sku: "" })],
    referenceRows: [ref("2026-08-29", 77, 1, { sku: "" })],
    calculatedAt: "T",
  });
  assert.equal(r.estimates[0].estimatedSales, 77);
});

// ---------------------------------------------------------------------------------------------------------------
group("computeOliSalesEstimates: NO cross-identity leakage");

for (const [label, over] of [
  ["account", { account_id: "OTHER" }],
  ["seller", { seller_or_vendor_id: "OTHER" }],
  ["currency", { currency: "USD" }],
  ["ASIN", { child_asin: "B0OTHER" }],
]) {
  test("never uses a reference from another " + label, () => {
    const r = ENG.computeOliSalesEstimates({
      accountId: ACC, accountMarketplace: "IN",
      operationalRows: [target("2026-08-29", 1)],
      referenceRows: [ref("2026-08-29", 100, 1, over)],
      calculatedAt: "T",
    });
    assert.equal(r.estimates.length, 0, label + " mismatch must not match");
    assert.equal(r.unresolved.length, 1);
  });
}

// ---------------------------------------------------------------------------------------------------------------
group("computeOliSalesEstimates: reference eligibility (reject cancelled / invalid)");

for (const [label, over] of [
  ["cancelled", { is_cancelled: true }],
  ["zero-price", { total_sales_sum: 0 }],
  ["negative-price", { total_sales_sum: -100 }],
  ["null-price", { total_sales_sum: null }],
  ["zero-quantity", { total_units_sum: 0 }],
]) {
  test("rejects a " + label + " reference row", () => {
    const r = ENG.computeOliSalesEstimates({
      accountId: ACC, accountMarketplace: "IN",
      operationalRows: [target("2026-08-29", 1)],
      referenceRows: [ref("2026-08-29", 100, 1, over)],
      calculatedAt: "T",
    });
    assert.equal(r.estimates.length, 0, label + " must be rejected");
  });
}

test("unresolved row is retained when NO trustworthy reference exists within 7 days", () => {
  const r = ENG.computeOliSalesEstimates({ accountId: ACC, accountMarketplace: "IN", operationalRows: [target("2026-08-29", 5)], referenceRows: [], calculatedAt: "T" });
  assert.equal(r.estimates.length, 0);
  assert.equal(r.unresolved.length, 1);
  assert.equal(r.unresolved[0].targetQuantity, 5);
});

test("a target with no missing units (fully priced) yields no estimate and no unresolved", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [target("2026-08-29", 0, { priced_units: 10, explicit_zero_units: 0, pending_units: 0 })],
    referenceRows: [ref("2026-08-29", 10)],
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 0);
  assert.equal(r.unresolved.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
group("computeOliSalesEstimates: idempotency + provenance");

test("re-running the SAME evidence produces byte-identical estimates (idempotent)", () => {
  const args = { accountId: ACC, accountMarketplace: "IN", operationalRows: [target("2026-08-29", 3)], referenceRows: [ref("2026-08-29", 100), ref("2026-08-28", 90)], calculatedAt: "T" };
  const a = ENG.computeOliSalesEstimates(args);
  const b = ENG.computeOliSalesEstimates(args);
  assert.deepEqual(a.estimates, b.estimates);
});

test("provenance captured: reference date, unit price, method, reference request hash, quantity, timestamp", () => {
  const r = ENG.computeOliSalesEstimates({ accountId: ACC, accountMarketplace: "IN", operationalRows: [target("2026-08-29", 2)], referenceRows: [ref("2026-08-28", 55)], calculatedAt: "STAMP" });
  const e = r.estimates[0];
  assert.equal(e.referenceDate, "2026-08-28");
  assert.equal(e.referenceUnitPrice, 55);
  assert.equal(e.matchingMethod, ENG.MATCH_SKU_EXACT);
  assert.equal(e.referenceSourceRequestHash, "hash-2026-08-28");
  assert.equal(e.targetQuantity, 2);
  assert.equal(e.calculatedAt, "STAMP");
  assert.equal(e.accountId, ACC);
  assert.equal(e.sellerOrVendorId, SELLER);
});

// ---------------------------------------------------------------------------------------------------------------
group("enrichOliHistoryRowsWithEstimates: additive merge + synthetic rows + actual supersedes");

test("adds the estimate to an EXISTING priced grain's sales_amount (units unchanged)", () => {
  const history = [{ account_id: ACC, seller_or_vendor_id: SELLER, sale_date: "2026-08-29", sku: "SKU-A", child_asin: "B0ASIN", currency: "INR", sales_amount: 200, units: 2 }];
  const estimates = [{ accountId: ACC, accountMarketplace: "IN", sellerOrVendorId: SELLER, saleDate: "2026-08-29", sku: "SKU-A", childAsin: "B0ASIN", currency: "INR", estimatedSales: 150 }];
  const enriched = ENG.enrichOliHistoryRowsWithEstimates(history, estimates);
  assert.equal(enriched.length, 1);
  assert.equal(enriched[0].sales_amount, 350);
  assert.equal(enriched[0].units, 2, "units are NEVER changed by the estimate");
  assert.equal(history[0].sales_amount, 200, "input is not mutated");
});

test("creates a SYNTHETIC row for a fully-unpriced grain (sales=estimate, units=0)", () => {
  const estimates = [{ accountId: ACC, accountMarketplace: "IN", sellerOrVendorId: SELLER, saleDate: "2026-08-29", sku: "SKU-A", childAsin: "B0ASIN", currency: "INR", estimatedSales: 120, referenceSourceRequestHash: "h" }];
  const enriched = ENG.enrichOliHistoryRowsWithEstimates([], estimates);
  assert.equal(enriched.length, 1);
  assert.equal(enriched[0].sales_amount, 120);
  assert.equal(enriched[0].units, 0);
  assert.equal(enriched[0].account_id, ACC);
  assert.equal(enriched[0].currency, "INR");
});

test("ACTUAL supersedes ESTIMATE with NO double-count as itemization arrives", () => {
  // State 1 (D-1): 1 priced unit @100 + 4 pending; estimate covers the 4 pending @100 -> enriched 500.
  const hist1 = [{ account_id: ACC, seller_or_vendor_id: SELLER, sale_date: "2026-08-29", sku: "SKU-A", child_asin: "B0ASIN", currency: "INR", sales_amount: 100, units: 1 }];
  const est1 = ENG.computeOliSalesEstimates({ accountId: ACC, accountMarketplace: "IN", operationalRows: [target("2026-08-29", 4, { priced_units: 1, pending_units: 4 })], referenceRows: [ref("2026-08-29", 100)], calculatedAt: "T" }).estimates;
  const enr1 = ENG.enrichOliHistoryRowsWithEstimates(hist1, est1);
  assert.equal(enr1[0].sales_amount, 500); // 100 priced + 400 estimate
  // State 2 (fully itemized): 5 priced units @100 -> 500 priced, 0 pending -> NO estimate. Enriched = 500 (no double).
  const hist2 = [{ account_id: ACC, seller_or_vendor_id: SELLER, sale_date: "2026-08-29", sku: "SKU-A", child_asin: "B0ASIN", currency: "INR", sales_amount: 500, units: 5 }];
  const est2 = ENG.computeOliSalesEstimates({ accountId: ACC, accountMarketplace: "IN", operationalRows: [target("2026-08-29", 0, { priced_units: 5, pending_units: 0 })], referenceRows: [ref("2026-08-29", 100)], calculatedAt: "T" }).estimates;
  assert.equal(est2.length, 0, "no missing units -> no estimate");
  const enr2 = ENG.enrichOliHistoryRowsWithEstimates(hist2, est2);
  assert.equal(enr2[0].sales_amount, 500, "actual only, never actual+estimate");
});

test("PARTIAL itemization: estimate covers ONLY the still-missing quantity (no double-count mid-way)", () => {
  // 3 priced @100 = 300, 2 still pending -> estimate covers only the 2 -> enriched 500 (not 300 + 5x100).
  const hist = [{ account_id: ACC, seller_or_vendor_id: SELLER, sale_date: "2026-08-29", sku: "SKU-A", child_asin: "B0ASIN", currency: "INR", sales_amount: 300, units: 3 }];
  const est = ENG.computeOliSalesEstimates({ accountId: ACC, accountMarketplace: "IN", operationalRows: [target("2026-08-29", 2, { priced_units: 3, pending_units: 2 })], referenceRows: [ref("2026-08-29", 100)], calculatedAt: "T" }).estimates;
  assert.equal(est[0].targetQuantity, 2);
  const enr = ENG.enrichOliHistoryRowsWithEstimates(hist, est);
  assert.equal(enr[0].sales_amount, 500);
});

test("resolvedEstimateGroupKeys marks resolved grains (for the missing-value breakdown)", () => {
  const est = [{ accountId: ACC, accountMarketplace: "IN", saleDate: "2026-08-29", sku: "SKU-A", childAsin: "B0ASIN", currency: "INR", estimatedSales: 10 }];
  const keys = ENG.resolvedEstimateGroupKeys(est);
  assert.equal(keys.has(ENG.oliGroupKey({ accountId: ACC, accountMarketplace: "IN", saleDate: "2026-08-29", sku: "SKU-A", childAsin: "B0ASIN", currency: "INR" })), true);
  assert.equal(keys.has(ENG.oliGroupKey({ accountId: ACC, accountMarketplace: "IN", saleDate: "2026-08-29", sku: "OTHER", childAsin: "B0ASIN", currency: "INR" })), false);
});

// ---------------------------------------------------------------------------------------------------------------
group("computeOliSalesEstimates: MARKETPLACE isolation (durable)");

test("DE account never cross-references an FR price (same EUR currency, different marketplace)", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "DE",
    operationalRows: [target("2026-08-29", 2, { currency: "EUR", marketplace_country_code: "DE" })],
    referenceRows: [ref("2026-08-29", 100, 1, { currency: "EUR", marketplace_country_code: "FR" })],
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 0, "an FR reference is never used for a DE account");
  assert.equal(r.unresolved.length, 1);
});

test("DE account DOES use a DE reference (same marketplace)", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "DE",
    operationalRows: [target("2026-08-29", 2, { currency: "EUR", marketplace_country_code: "DE" })],
    referenceRows: [ref("2026-08-29", 100, 1, { currency: "EUR", marketplace_country_code: "DE" })],
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 1);
  assert.equal(r.estimates[0].estimatedSales, 200);
  assert.equal(r.estimates[0].marketplaceCountryCode, "DE");
});

test("same seller shared across EUR marketplaces stays isolated (FR reference rejected under a DE account)", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "DE",
    operationalRows: [target("2026-08-29", 1, { currency: "EUR", marketplace_country_code: "DE" })],
    referenceRows: [
      ref("2026-08-29", 999, 1, { currency: "EUR", marketplace_country_code: "FR" }), // FR (same seller/ASIN/SKU) -> rejected
      ref("2026-08-28", 50, 1, { currency: "EUR", marketplace_country_code: "DE" }),   // DE -> used
    ],
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 1);
  assert.equal(r.estimates[0].referenceUnitPrice, 50, "only the DE reference is used");
  assert.equal(r.estimates[0].referenceDate, "2026-08-28");
});

test("UK/GB canonical equivalence: a GB reference serves a UK account (and a UK row a GB account)", () => {
  const r1 = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "UK",
    operationalRows: [target("2026-08-29", 1, { currency: "GBP", marketplace_country_code: "UK" })],
    referenceRows: [ref("2026-08-29", 80, 1, { currency: "GBP", marketplace_country_code: "GB" })],
    calculatedAt: "T",
  });
  assert.equal(r1.estimates.length, 1, "GB reference matches a UK account (both canonicalize to GB)");
  assert.equal(r1.estimates[0].marketplaceCountryCode, "GB");
  const r2 = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "GB",
    operationalRows: [target("2026-08-29", 1, { currency: "GBP", marketplace_country_code: "UK" })],
    referenceRows: [ref("2026-08-29", 80, 1, { currency: "GBP", marketplace_country_code: "GB" })],
    calculatedAt: "T",
  });
  assert.equal(r2.estimates.length, 1, "a UK target row matches a GB account");
});

test("blank account marketplace FAILS CLOSED (every grain unresolved, zero estimates)", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "",
    operationalRows: [target("2026-08-29", 3)],
    referenceRows: [ref("2026-08-29", 100)],
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 0, "no authoritative marketplace -> never estimated");
  assert.equal(r.unresolved.length, 1);
  assert.equal(r.unresolved[0].reason, "no-authoritative-marketplace");
});

test("a target row whose OWN marketplace mismatches the account is left unresolved (never estimated)", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "DE",
    operationalRows: [target("2026-08-29", 2, { currency: "EUR", marketplace_country_code: "FR" })],
    referenceRows: [ref("2026-08-29", 100, 1, { currency: "EUR", marketplace_country_code: "DE" })],
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 0, "a wrong-marketplace target is never estimated under this account");
  assert.ok(r.unresolved.some((u) => u.reason === "marketplace-mismatch"));
});

test("INR + USD estimates stay byte-identical when marketplace matches the account (no regression)", () => {
  const inr = ENG.computeOliSalesEstimates({ accountId: ACC, accountMarketplace: "IN", operationalRows: [target("2026-08-29", 2)], referenceRows: [ref("2026-08-29", 100)], calculatedAt: "T" });
  assert.equal(inr.estimates[0].estimatedSales, 200);
  const usd = ENG.computeOliSalesEstimates({ accountId: ACC, accountMarketplace: "US", operationalRows: [target("2026-08-29", 2, { currency: "USD", marketplace_country_code: "US" })], referenceRows: [ref("2026-08-29", 10, 1, { currency: "USD", marketplace_country_code: "US" })], calculatedAt: "T" });
  assert.equal(usd.estimates[0].estimatedSales, 20);
});

main().then((f) => { if (f) process.exitCode = 1; }).catch((e) => { out("FATAL " + String(e && e.stack ? e.stack : e)); process.exitCode = 1; });
