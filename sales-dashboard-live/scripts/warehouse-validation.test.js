// TRUSTED server-side warehouse-write validation -- the API boundary. Proves that a FORGED request (unknown/cross-
// account SKU, conflicting SKU->ASIN, out-of-scope marketplace, browser-supplied identity) is REJECTED, and that a
// bulk with ANY invalid row yields ok=false so the endpoint returns before the atomic RPC (zero writes). The endpoint
// (api/fba-plan-config.js) calls these BEFORE recordFbaSellerWarehouse[Bulk], so a false result means no write occurs.
// 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { buildWarehouseAuthority, validateWarehouseRow, validateWarehouseRows } from "../lib/server/reports/warehouse-validation.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// A v2d-5 snapshot payload (directory + catalog + marketplace scope).
const V5 = {
  marketCountry: "US",
  accountSkus: ["EXIST-1", "EXIST-2"],
  accountSkuDirectory: [
    { sku: "EXIST-1", childAsin: "ASIN1", brand: "Acme", marketplace: "US", provenance: "inventory" },
    { sku: "EXIST-2", childAsin: "ASIN2", brand: "Beta", marketplace: "US", provenance: "sales" },
  ],
  catalogByAsin: { ASIN1: { brand: "Acme", productName: "Widget" }, ASIN2: { brand: "Beta" }, ASIN3: { brand: "Gamma" } },
};

test("existing SKU: child ASIN resolved from the directory; a blank ASIN is fine", () => {
  const a = buildWarehouseAuthority(V5);
  const r = validateWarehouseRow({ marketplace: "US", sku: "EXIST-1", childAsin: "" }, a);
  assert.equal(r.ok, true);
  assert.equal(r.resolvedChildAsin, "ASIN1", "server resolves the trusted ASIN, ignoring the blank browser value");
});

test("FORGED: unknown SKU with a non-catalog ASIN is rejected", () => {
  const a = buildWarehouseAuthority(V5);
  const r = validateWarehouseRow({ marketplace: "US", sku: "HACK-1", childAsin: "ASIN-NOPE" }, a);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(";"), /not in this account's catalog/);
});

test("new MANUAL SKU: child ASIN mandatory + must exist in the catalog", () => {
  const a = buildWarehouseAuthority(V5);
  assert.equal(validateWarehouseRow({ marketplace: "US", sku: "NEW-1", childAsin: "" }, a).ok, false, "no ASIN -> rejected");
  assert.equal(validateWarehouseRow({ marketplace: "US", sku: "NEW-1", childAsin: "ASIN3" }, a).ok, true, "catalog ASIN -> ok");
  assert.equal(validateWarehouseRow({ marketplace: "US", sku: "NEW-1", childAsin: "ASINX" }, a).ok, false, "non-catalog ASIN -> rejected");
});

test("FORGED: conflicting SKU -> ASIN mapping is rejected (directory is authoritative)", () => {
  const a = buildWarehouseAuthority(V5);
  const r = validateWarehouseRow({ marketplace: "US", sku: "EXIST-1", childAsin: "ASIN2" }, a);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(";"), /SKU maps to ASIN1, not ASIN2/);
});

test("FORGED: an out-of-scope marketplace is rejected", () => {
  const a = buildWarehouseAuthority(V5);
  const r = validateWarehouseRow({ marketplace: "DE", sku: "EXIST-1", childAsin: "" }, a);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(";"), /marketplace DE is not in this account/);
});

test("browser-supplied identity is ignored: only marketplace+sku+childAsin are read", () => {
  const a = buildWarehouseAuthority(V5);
  // A forged brand/provenance/account on the row cannot help it pass.
  const r = validateWarehouseRow({ marketplace: "US", sku: "HACK", childAsin: "ASINX", brand: "Acme", provenance: "inventory", accountId: "someone-else" }, a);
  assert.equal(r.ok, false);
});

test("BULK: any invalid row => ok=false and it is excluded from valid (endpoint returns BEFORE the RPC => zero writes)", () => {
  const a = buildWarehouseAuthority(V5);
  const rows = [
    { marketplace: "US", sku: "EXIST-1", childAsin: "", qty: 5 },
    { marketplace: "US", sku: "HACK", childAsin: "ASINX", qty: 9 }, // forged
  ];
  const res = validateWarehouseRows(rows, a);
  assert.equal(res.ok, false, "one forged row fails the whole import");
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].sku, "HACK");
  // The endpoint only calls the atomic RPC when res.ok is true, so nothing is written.
});

test("BULK: a clean import resolves ASINs + de-dups; ok=true", () => {
  const a = buildWarehouseAuthority(V5);
  const res = validateWarehouseRows([
    { marketplace: "US", sku: "EXIST-1", childAsin: "", qty: 5 },
    { marketplace: "US", sku: "EXIST-2", childAsin: "ASIN2", qty: 3 },
    { marketplace: "US", sku: "EXIST-2", childAsin: "ASIN2", qty: 8 }, // duplicate
  ], a);
  assert.equal(res.ok, false, "the duplicate makes the import invalid");
  assert.match(res.errors[0].problems.join(";"), /duplicate/);
  const clean = validateWarehouseRows([{ marketplace: "US", sku: "EXIST-1", childAsin: "", qty: 5 }], a);
  assert.equal(clean.ok, true);
  assert.equal(clean.valid[0].childAsin, "ASIN1", "server-resolved ASIN");
});

test("v2d-4 fallback (accountSkus only): existing SKU passes; a new SKU is rejected (no catalog to verify the ASIN)", () => {
  const a = buildWarehouseAuthority({ marketCountry: "US", accountSkus: ["EXIST-1"] });
  assert.equal(a.hasDirectory, false);
  assert.equal(validateWarehouseRow({ marketplace: "US", sku: "EXIST-1", childAsin: "" }, a).ok, true);
  const nw = validateWarehouseRow({ marketplace: "US", sku: "NEW-1", childAsin: "ASIN3" }, a);
  assert.equal(nw.ok, false);
  assert.match(nw.problems.join(";"), /refresh the FBA plan/);
});

test("no published snapshot => every write is rejected (fail closed)", () => {
  const a = buildWarehouseAuthority(null);
  assert.equal(a.hasSnapshot, false);
  const r = validateWarehouseRow({ marketplace: "US", sku: "EXIST-1", childAsin: "ASIN1" }, a);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(";"), /no published FBA plan/);
});

let failures = 0;
for (const t of tests) {
  try { t.fn(); passed += 1; out("  ok  " + t.name); }
  catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
}
out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
if (failures) process.exitCode = 1;
