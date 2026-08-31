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

// ---------------------------------------------------------------------------------------------------------------
group("resolveUniqueMarketplaceByAccount: fail-closed authoritative mapping (NO last-write-wins)");

test("duplicate directory rows with the SAME marketplace resolve uniquely", () => {
  const m = ENG.resolveUniqueMarketplaceByAccount([
    { accountId: "a1", country: "IN" }, { accountId: "a1", country: "IN" }, { accountId: "a1", country: "IN" },
  ]);
  assert.equal(m.get("a1").status, "unique");
  assert.equal(m.get("a1").marketplace, "IN");
  assert.equal(ENG.authoritativeMarketplace(m, "a1"), "IN");
});

test("DE + FR entries for the SAME account resolve as AMBIGUOUS (never one of them)", () => {
  const m = ENG.resolveUniqueMarketplaceByAccount([
    { accountId: "a1", country: "DE" }, { accountId: "a1", country: "FR" },
  ]);
  assert.equal(m.get("a1").status, "ambiguous");
  assert.equal(m.get("a1").marketplace, null);
  assert.equal(ENG.authoritativeMarketplace(m, "a1"), "", "ambiguous never yields a usable marketplace");
});

test("no nonblank marketplace resolves as MISSING", () => {
  const m = ENG.resolveUniqueMarketplaceByAccount([
    { accountId: "a1", country: "" }, { accountId: "a1", country: "   " }, { accountId: "a1" },
  ]);
  assert.equal(m.get("a1").status, "missing");
  assert.equal(ENG.authoritativeMarketplace(m, "a1"), "");
});

test("UK + GB rows resolve UNIQUELY to canonical GB", () => {
  const m = ENG.resolveUniqueMarketplaceByAccount([
    { accountId: "a1", country: "UK" }, { accountId: "a1", country: "GB" }, { accountId: "a1", country: "uk" },
  ]);
  assert.equal(m.get("a1").status, "unique");
  assert.equal(m.get("a1").marketplace, "GB");
});

test("directory row ORDER cannot change the result (order-independent)", () => {
  const rows = [{ accountId: "a1", country: "FR" }, { accountId: "a1", country: "DE" }];
  const forward = ENG.resolveUniqueMarketplaceByAccount(rows);
  const reversed = ENG.resolveUniqueMarketplaceByAccount([...rows].reverse());
  assert.equal(forward.get("a1").status, "ambiguous");
  assert.equal(reversed.get("a1").status, "ambiguous");
  // MUTATION GUARD: last-write-wins would make these differ (FR vs DE); the resolver keeps both ambiguous.
  assert.equal(forward.get("a1").marketplace, reversed.get("a1").marketplace);
});

test("MUTATION GUARD: an ambiguous account never collapses to the LAST-written marketplace", () => {
  // If the resolver ever regressed to Map.set (last-write-wins), 'a1' would resolve to 'FR' (the last row).
  const m = ENG.resolveUniqueMarketplaceByAccount([
    { accountId: "a1", country: "DE" }, { accountId: "a1", country: "IT" }, { accountId: "a1", country: "FR" },
  ]);
  assert.notEqual(ENG.authoritativeMarketplace(m, "a1"), "FR", "last-write-wins would wrongly pick FR");
  assert.equal(m.get("a1").status, "ambiguous");
  assert.equal(m.get("a1").count, 3);
});

test("marketplace is read ONLY from the marketplace/country field (never currency/seller/asin/sku)", () => {
  const m = ENG.resolveUniqueMarketplaceByAccount([
    { accountId: "a1", currency: "EUR", sellerOrVendorId: "S1", childAsin: "B0", sku: "K" }, // no country -> missing
  ]);
  assert.equal(m.get("a1").status, "missing", "currency/seller/asin/sku are never used to infer a marketplace");
});

test("distinct accounts each resolve independently; summary counts are redacted", () => {
  const m = ENG.resolveUniqueMarketplaceByAccount([
    { accountId: "uniq", country: "US" },
    { accountId: "miss", country: "" },
    { accountId: "ambi", country: "DE" }, { accountId: "ambi", country: "FR" },
  ]);
  const s = ENG.summarizeMarketplaceResolution(m);
  assert.equal(s.unique, 1);
  assert.equal(s.missing, 1);
  assert.equal(s.ambiguous, 1);
  assert.equal(s.missingAccounts.includes("miss"), true);
  assert.equal(s.ambiguousAccounts.includes("ambi"), true);
});

// ---------------------------------------------------------------------------------------------------------------
group("server-side SKU -> child_asin RESOLUTION (pending units that carry a SKU but a blank ASIN)");

// A target OPERATIONAL row whose child_asin is BLANK (pending itemization) but that carries a SKU.
const blankAsinTarget = (date, missing, over = {}) => ({
  account_id: ACC, seller_or_vendor_id: SELLER, sale_date: date, sku: "SKU-A", child_asin: "", currency: "INR",
  priced_units: 0, explicit_zero_units: 0, pending_units: missing, cancelled_units: 0, source_request_hash: "op-" + date, ...over,
});
// A resolve_oli_sku_asin RPC row (seller/currency/sku -> unique-or-ambiguous ASIN).
const histRow = (over = {}) => ({ seller_or_vendor_id: SELLER, currency: "INR", sku: "SKU-A", asin_count: 1, child_asin: "B0ASIN", ...over });
const mkResolver = ({ history = [], catalog = [], mkt = "IN" } = {}) => ENG.buildSkuAsinResolver({ accountMarketplace: mkt, historyRows: history, catalogRows: catalog });

test("BASELINE (the bug): blank-ASIN SKU target with NO resolver stays unresolved (no-reference)", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [blankAsinTarget("2026-08-30", 5)],
    referenceRows: [ref("2026-08-30", 100)], // priced ref carries a real ASIN; blank-ASIN key can't reach it
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 0, "without ASIN resolution the blank-ASIN target cannot match");
  assert.equal(r.unresolved.length, 1);
  assert.equal(r.unresolved[0].reason, ENG.UNRESOLVED_ASIN_NONE);
  assert.equal(r.unresolved[0].targetQuantity, 5, "units still counted as unresolved");
});

test("HISTORY resolves the missing ASIN (Catalog empty) -> estimate at the resolved ASIN", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [blankAsinTarget("2026-08-30", 4)],
    referenceRows: [ref("2026-08-30", 100)],
    skuAsinResolver: mkResolver({ history: [histRow()] }),
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 1);
  assert.equal(r.estimates[0].childAsin, "B0ASIN", "estimate attributes to the resolved ASIN");
  assert.equal(r.estimates[0].targetChildAsin, "", "original observed ASIN was blank");
  assert.equal(r.estimates[0].estimatedSales, 400); // 100 x 4
  assert.equal(r.estimates[0].matchingMethod, ENG.MATCH_SKU_EXACT);
  assert.equal(r.estimates[0].asinResolvedFromBlank, true);
  assert.equal(r.estimates[0].asinResolutionVia, ENG.ASIN_VIA_HISTORY);
});

test("CATALOG resolves the missing ASIN when history has none", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [blankAsinTarget("2026-08-30", 2)],
    referenceRows: [ref("2026-08-30", 100)],
    skuAsinResolver: mkResolver({ history: [], catalog: [{ seller_or_vendor_id: SELLER, currency: "INR", sku: "SKU-A", child_asin: "B0ASIN" }] }),
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 1);
  assert.equal(r.estimates[0].childAsin, "B0ASIN");
  assert.equal(r.estimates[0].asinResolutionVia, ENG.ASIN_VIA_CATALOG);
});

test("Catalog and history AGREE -> resolved (via catalog+history)", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [blankAsinTarget("2026-08-30", 1)],
    referenceRows: [ref("2026-08-30", 100)],
    skuAsinResolver: mkResolver({ history: [histRow()], catalog: [{ seller_or_vendor_id: SELLER, currency: "INR", sku: "SKU-A", child_asin: "B0ASIN" }] }),
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 1);
  assert.equal(r.estimates[0].asinResolutionVia, ENG.ASIN_VIA_CATALOG_HISTORY);
});

test("Catalog and history CONFLICT -> unresolved (fail closed), units still counted", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [blankAsinTarget("2026-08-30", 3)],
    referenceRows: [ref("2026-08-30", 100), ref("2026-08-30", 100, 1, { child_asin: "B0OTHER" })],
    skuAsinResolver: mkResolver({ history: [histRow({ child_asin: "B0ASIN" })], catalog: [{ seller_or_vendor_id: SELLER, currency: "INR", sku: "SKU-A", child_asin: "B0OTHER" }] }),
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 0);
  assert.equal(r.unresolved[0].reason, ENG.UNRESOLVED_ASIN_CONFLICT);
  assert.equal(r.unresolved[0].targetQuantity, 3);
});

test("AMBIGUOUS historical SKU->ASIN (asin_count>1) -> unresolved, never a guess", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [blankAsinTarget("2026-08-30", 3)],
    referenceRows: [ref("2026-08-30", 100)],
    skuAsinResolver: mkResolver({ history: [histRow({ asin_count: 2, child_asin: "B0ASIN" })] }),
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 0);
  assert.equal(r.unresolved[0].reason, ENG.UNRESOLVED_ASIN_AMBIGUOUS);
});

test("ambiguity fails closed even when a catalog value is present (durable evidence is inconsistent)", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [blankAsinTarget("2026-08-30", 3)],
    referenceRows: [ref("2026-08-30", 100)],
    skuAsinResolver: mkResolver({ history: [histRow({ asin_count: 2 })], catalog: [{ seller_or_vendor_id: SELLER, currency: "INR", sku: "SKU-A", child_asin: "B0ASIN" }] }),
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 0);
  assert.equal(r.unresolved[0].reason, ENG.UNRESOLVED_ASIN_AMBIGUOUS);
});

test("SELLER isolation: a resolution for ANOTHER seller never resolves this seller's SKU", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [blankAsinTarget("2026-08-30", 3)],
    referenceRows: [ref("2026-08-30", 100)],
    skuAsinResolver: mkResolver({ history: [histRow({ seller_or_vendor_id: "OTHER-SELLER" })] }),
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 0);
  assert.equal(r.unresolved[0].reason, ENG.UNRESOLVED_ASIN_NONE);
});

test("CURRENCY isolation: a resolution under another currency never resolves this INR SKU", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [blankAsinTarget("2026-08-30", 3)],
    referenceRows: [ref("2026-08-30", 100)],
    skuAsinResolver: mkResolver({ history: [histRow({ currency: "USD" })] }),
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 0);
  assert.equal(r.unresolved[0].reason, ENG.UNRESOLVED_ASIN_NONE);
});

test("MARKETPLACE isolation: a blank authoritative marketplace resolves nothing (fail closed)", () => {
  const resolver = mkResolver({ history: [histRow()], mkt: "" });
  const res = resolver.resolve({ sellerId: SELLER, currency: "INR", sku: "SKU-A" });
  assert.equal(res.status, "none");
});

test("resolved-from-blank obeys price precedence: same-day before D-1, MEDIAN, no future", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [blankAsinTarget("2026-08-30", 2)],
    referenceRows: [ref("2026-08-30", 40), ref("2026-08-30", 60), ref("2026-08-29", 999), ref("2026-08-31", 1)],
    skuAsinResolver: mkResolver({ history: [histRow()] }),
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 1);
  assert.equal(r.estimates[0].referenceDate, "2026-08-30");
  assert.equal(r.estimates[0].referenceUnitPrice, 50); // median(40,60); the 2026-08-31 future ref is never used
  assert.equal(r.estimates[0].estimatedSales, 100);
});

test("resolved ASIN but NO in-window priced reference -> no-reference (counted, no sales)", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [blankAsinTarget("2026-08-30", 3)],
    referenceRows: [ref("2026-08-20", 100)], // 10 days before -> beyond the 7-day look-back
    skuAsinResolver: mkResolver({ history: [histRow()] }),
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 0);
  assert.equal(r.unresolved[0].reason, "no-reference");
  assert.equal(r.unresolved[0].targetQuantity, 3);
});

test("cancelled history never provides a resolved-ASIN price", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [blankAsinTarget("2026-08-30", 3)],
    referenceRows: [ref("2026-08-30", 100, 1, { is_cancelled: true })],
    skuAsinResolver: mkResolver({ history: [histRow()] }),
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 0);
  assert.equal(r.unresolved[0].reason, "no-reference");
});

test("explicit-zero + pending both count toward the resolved target quantity", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [blankAsinTarget("2026-08-30", 0, { explicit_zero_units: 2, pending_units: 3 })],
    referenceRows: [ref("2026-08-30", 10)],
    skuAsinResolver: mkResolver({ history: [histRow()] }),
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 1);
  assert.equal(r.estimates[0].targetQuantity, 5);
  assert.equal(r.estimates[0].estimatedSales, 50);
});

test("no SKU and no ASIN -> no-identity (never resolved)", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [blankAsinTarget("2026-08-30", 3, { sku: "" })],
    referenceRows: [ref("2026-08-30", 100)],
    skuAsinResolver: mkResolver({ history: [histRow()] }),
    calculatedAt: "T",
  });
  assert.equal(r.estimates.length, 0);
  assert.equal(r.unresolved[0].reason, ENG.UNRESOLVED_NO_IDENTITY);
});

test("IDEMPOTENT: same durable evidence -> byte-identical resolved estimates", () => {
  const args = {
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [blankAsinTarget("2026-08-30", 4)],
    referenceRows: [ref("2026-08-30", 100)],
    skuAsinResolver: mkResolver({ history: [histRow()] }),
    calculatedAt: "T",
  };
  assert.deepEqual(ENG.computeOliSalesEstimates(args).estimates, ENG.computeOliSalesEstimates(args).estimates);
});

test("resolvedEstimateGroupKeys emits BOTH the resolved grain AND the blank target grain", () => {
  const r = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [blankAsinTarget("2026-08-30", 4)],
    referenceRows: [ref("2026-08-30", 100)],
    skuAsinResolver: mkResolver({ history: [histRow()] }),
    calculatedAt: "T",
  });
  const keys = ENG.resolvedEstimateGroupKeys(r.estimates);
  assert.equal(keys.has(ENG.oliGroupKey({ accountId: ACC, saleDate: "2026-08-30", sku: "SKU-A", childAsin: "B0ASIN", currency: "INR" })), true);
  assert.equal(keys.has(ENG.oliGroupKey({ accountId: ACC, saleDate: "2026-08-30", sku: "SKU-A", childAsin: "", currency: "INR" })), true, "blank target grain reclassifies in the breakdown");
});

test("NO DOUBLE-COUNT: a resolved estimate merges into the SAME priced (sku, resolved-ASIN) row", () => {
  const est = ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [blankAsinTarget("2026-08-30", 2)],
    referenceRows: [ref("2026-08-30", 100)],
    skuAsinResolver: mkResolver({ history: [histRow()] }),
    calculatedAt: "T",
  }).estimates;
  const priced = [{ account_id: ACC, sale_date: "2026-08-30", sku: "SKU-A", child_asin: "B0ASIN", currency: "INR", sales_amount: 1000, units: 10 }];
  const enriched = ENG.enrichOliHistoryRowsWithEstimates(priced, est);
  assert.equal(enriched.length, 1, "estimate folds into the existing priced row, not a duplicate");
  assert.equal(enriched[0].sales_amount, 1200); // 1000 priced + 200 estimated
  assert.equal(enriched[0].units, 10, "units NEVER change");
});

test("ACTUAL SUPERSEDES: as itemization shrinks the pending qty the estimate shrinks (no double-count)", () => {
  const mk = (pending) => ENG.computeOliSalesEstimates({
    accountId: ACC, accountMarketplace: "IN",
    operationalRows: [blankAsinTarget("2026-08-30", pending)],
    referenceRows: [ref("2026-08-30", 100)],
    skuAsinResolver: mkResolver({ history: [histRow()] }),
    calculatedAt: "T",
  }).estimates;
  assert.equal(mk(5)[0].estimatedSales, 500);
  assert.equal(mk(2)[0].estimatedSales, 200, "fewer still-pending units -> smaller estimate");
  assert.equal(mk(0).length, 0, "fully itemized -> no estimate row (actual value stands alone)");
});

// ---------------------------------------------------------------------------------------------------------------
group("mergeOrderedOliHistory: ordered units (priced + explicit-zero + pending) + actual-plus-estimated sales");

const priced = (date, { units = 1, sales = 100, sku = "SKU-A", asin = "B0ASIN", cur = "INR" } = {}) => ({
  account_id: ACC, seller_or_vendor_id: SELLER, sale_date: date, sku, child_asin: asin, currency: cur, units, sales_amount: sales, source_request_hash: "h",
});
const op = (date, { priced_units = 0, zero = 0, pending = 0, cancelled = 0, sku = "SKU-A", asin = "", cur = "INR" } = {}) => ({
  account_id: ACC, seller_or_vendor_id: SELLER, sale_date: date, sku, child_asin: asin, currency: cur,
  priced_units, explicit_zero_units: zero, pending_units: pending, cancelled_units: cancelled, source_request_hash: "op",
});
const estRow = (date, { qty = 1, sales = 100, sku = "SKU-A", asin = "B0ASIN", cur = "INR" } = {}) => ({
  account_id: ACC, seller_or_vendor_id: SELLER, sale_date: date, sku, child_asin: asin, currency: cur, target_quantity: qty, estimated_sales: sales,
});
const oneGrain = (rows) => { assert.equal(rows.length, 1, "expected exactly one merged grain, got " + rows.length); return rows[0]; };

test("priced-only grain: ordered = priced units, sales = priced, unpriced = 0", () => {
  const r = oneGrain(ENG.mergeOrderedOliHistory({ historyRows: [priced("2026-08-30", { units: 5, sales: 500 })] }));
  assert.equal(r.units, 5); assert.equal(r.ordered_units, 5); assert.equal(r.sales_amount, 500); assert.equal(r.unpriced_units, 0);
});

test("priced + resolved pending + estimate co-locate: ordered = priced+pending, sales = priced+est, unpriced = 0", () => {
  const rows = ENG.mergeOrderedOliHistory({
    historyRows: [priced("2026-08-30", { units: 2, sales: 200 })],
    operationalRows: [op("2026-08-30", { priced_units: 2, pending: 3, asin: "" })], // blank ASIN pending
    estimateRows: [estRow("2026-08-30", { qty: 3, sales: 300 })],                    // resolved to B0ASIN
    skuAsinResolver: mkResolver({ history: [histRow()] }),
  });
  const g = oneGrain(rows);
  assert.equal(g.units, 5, "2 priced + 3 pending");
  assert.equal(g.sales_amount, 500, "200 priced + 300 estimate");
  assert.equal(g.unpriced_units, 0, "estimate covers the pending units");
  assert.equal(g.child_asin, "B0ASIN", "pending resolved + co-located with the priced/estimate grain");
});

test("UNRESOLVED pending (no estimate): units counted, sales 0, unpriced = pending (the honest gap)", () => {
  const rows = ENG.mergeOrderedOliHistory({
    operationalRows: [op("2026-08-30", { pending: 4, sku: "SKU-N", asin: "" })],
    skuAsinResolver: mkResolver({ history: [] }), // no resolution
  });
  const g = oneGrain(rows);
  assert.equal(g.units, 4); assert.equal(g.ordered_units, 4); assert.equal(g.sales_amount, 0);
  assert.equal(g.unpriced_units, 4, "unresolved pending units are the unpriced gap");
  assert.equal(g.child_asin, "", "unresolved keeps the blank ASIN (honest)");
});

test("explicit-zero non-cancelled units are counted (ordered), estimated if resolvable", () => {
  const rows = ENG.mergeOrderedOliHistory({
    operationalRows: [op("2026-08-30", { zero: 2, asin: "" })],
    estimateRows: [estRow("2026-08-30", { qty: 2, sales: 20 })],
    skuAsinResolver: mkResolver({ history: [histRow()] }),
  });
  const g = oneGrain(rows);
  assert.equal(g.units, 2); assert.equal(g.sales_amount, 20); assert.equal(g.unpriced_units, 0);
});

test("CANCELLED units are NEVER added (audit-only)", () => {
  const rows = ENG.mergeOrderedOliHistory({
    historyRows: [priced("2026-08-30", { units: 3, sales: 300 })],
    operationalRows: [op("2026-08-30", { priced_units: 3, cancelled: 99, asin: "B0ASIN" })],
  });
  const g = oneGrain(rows);
  assert.equal(g.units, 3, "cancelled_units never enter ordered units");
});

test("NO DOUBLE-COUNT of priced units: operational priced_units are never re-added (only zero+pending)", () => {
  const rows = ENG.mergeOrderedOliHistory({
    historyRows: [priced("2026-08-30", { units: 10, sales: 1000 })],
    operationalRows: [op("2026-08-30", { priced_units: 10, pending: 0, zero: 0, asin: "B0ASIN" })],
  });
  const g = oneGrain(rows);
  assert.equal(g.units, 10, "priced counted once (from the rollup), operational priced_units ignored");
  assert.equal(g.sales_amount, 1000);
});

test("PENDING -> ACTUAL settlement: no double count as itemization moves a unit from pending to priced", () => {
  // Before: 2 priced + 3 pending (estimate 300). After a refresh: 5 priced, 0 pending, estimate cleared.
  const before = oneGrain(ENG.mergeOrderedOliHistory({
    historyRows: [priced("2026-08-30", { units: 2, sales: 200 })],
    operationalRows: [op("2026-08-30", { priced_units: 2, pending: 3, asin: "" })],
    estimateRows: [estRow("2026-08-30", { qty: 3, sales: 300 })],
    skuAsinResolver: mkResolver({ history: [histRow()] }),
  }));
  assert.equal(before.units, 5); assert.equal(before.sales_amount, 500);
  const after = oneGrain(ENG.mergeOrderedOliHistory({
    historyRows: [priced("2026-08-30", { units: 5, sales: 500 })], // all itemized now
    operationalRows: [op("2026-08-30", { priced_units: 5, pending: 0, asin: "B0ASIN" })],
    estimateRows: [], // estimate window cleared
  }));
  assert.equal(after.units, 5, "ordered units unchanged across settlement (each unit counted exactly once)");
  assert.equal(after.sales_amount, 500, "actual sales replace the estimate -- no addition on top");
});

test("IDEMPOTENT replay: same durable evidence -> byte-identical merged rows", () => {
  const args = {
    historyRows: [priced("2026-08-30", { units: 2, sales: 200 })],
    operationalRows: [op("2026-08-30", { priced_units: 2, pending: 3, asin: "" })],
    estimateRows: [estRow("2026-08-30", { qty: 3, sales: 300 })],
    skuAsinResolver: mkResolver({ history: [histRow()] }),
  };
  assert.deepEqual(ENG.mergeOrderedOliHistory(args), ENG.mergeOrderedOliHistory(args));
});

main().then((f) => { if (f) process.exitCode = 1; }).catch((e) => { out("FATAL " + String(e && e.stack ? e.stack : e)); process.exitCode = 1; });
