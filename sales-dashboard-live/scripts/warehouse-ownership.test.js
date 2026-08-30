// Durable ACCOUNT-SKU OWNERSHIP row building. Proves ownership rows are produced from COMPLETE trusted evidence -- a
// SKU proven ONLY through FBA Inventory, ONLY through AWD, ONLY through OLI sales (incl. operational/pending), or ONLY
// through the account's own warehouse -- each becomes an ownership row, canonical-marketplace scoped, with no reliance
// on the org-wide Product Catalog. Same SKU text in two legitimate marketplaces => two distinct rows. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { buildOwnershipRows } from "../lib/server/reports/warehouse-ownership.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const byKey = (rows) => Object.fromEntries(rows.map((r) => [`${r.marketplace} ${r.sku}`, r]));

test("every directory provenance (inventory / AWD / OLI sales) becomes an ownership row", () => {
  const payload = {
    marketCountry: "US",
    accountSkuDirectory: [
      { sku: "INV-ONLY", childAsin: "ASIN1", marketplace: "US", provenance: "inventory" },
      { sku: "AWD-ONLY", childAsin: "ASIN2", marketplace: "US", provenance: "awd" },
      { sku: "OLI-ONLY", childAsin: "ASIN3", marketplace: "US", provenance: "sales" },
    ],
  };
  const rows = buildOwnershipRows(payload, []);
  const m = byKey(rows);
  assert.ok(m["US INV-ONLY"] && m["US INV-ONLY"].sources.includes("inventory"));
  assert.ok(m["US AWD-ONLY"] && m["US AWD-ONLY"].sources.includes("awd"));
  assert.ok(m["US OLI-ONLY"] && m["US OLI-ONLY"].sources.includes("sales"));
  assert.equal(m["US INV-ONLY"].child_asin, "ASIN1");
});

test("a SKU stored ONLY in the account's warehouse becomes an ownership row (provenance warehouse)", () => {
  const rows = buildOwnershipRows({ marketCountry: "US", accountSkuDirectory: [] }, [{ marketplace: "US", sku: "WH-ONLY", child_asin: "ASIN9" }]);
  const m = byKey(rows);
  assert.ok(m["US WH-ONLY"]);
  assert.equal(m["US WH-ONLY"].sources, "warehouse");
  assert.equal(m["US WH-ONLY"].child_asin, "ASIN9");
});

test("directory + warehouse for the same (mkt, sku) merge into ONE row (sources combined, ASIN preserved)", () => {
  const rows = buildOwnershipRows(
    { marketCountry: "US", accountSkuDirectory: [{ sku: "S1", childAsin: "ASIN1", marketplace: "US", provenance: "inventory" }] },
    [{ marketplace: "US", sku: "S1", child_asin: "ASIN1" }],
  );
  const m = byKey(rows);
  assert.equal(Object.keys(m).length, 1);
  assert.equal(m["US S1"].child_asin, "ASIN1");
  assert.match(m["US S1"].sources, /inventory/);
  assert.match(m["US S1"].sources, /warehouse/);
});

test("canonical marketplace: GB directory entry is stored as UK", () => {
  const rows = buildOwnershipRows({ marketCountry: "GB", accountSkuDirectory: [{ sku: "S1", childAsin: "ASIN1", marketplace: "GB", provenance: "inventory" }] }, []);
  assert.equal(rows[0].marketplace, "UK");
});

test("same SKU text in two legitimate marketplaces => two distinct ownership rows", () => {
  const rows = buildOwnershipRows({
    marketCountry: "US",
    accountSkuDirectory: [
      { sku: "SHARED", childAsin: "ASIN1", marketplace: "US", provenance: "inventory" },
      { sku: "SHARED", childAsin: "ASIN2", marketplace: "DE", provenance: "inventory" },
    ],
  }, []);
  const m = byKey(rows);
  assert.ok(m["US SHARED"] && m["DE SHARED"], "distinct by marketplace");
  assert.notEqual(m["US SHARED"].child_asin, m["DE SHARED"].child_asin);
});

test("a directory entry with no marketplace falls back to the account marketCountry; blank SKU is skipped", () => {
  const rows = buildOwnershipRows({ marketCountry: "US", accountSkuDirectory: [{ sku: "S1", childAsin: "ASIN1", provenance: "sales" }, { sku: "", childAsin: "ASINX" }] }, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].marketplace, "US");
});

test("the org-wide catalog is NOT a source of ownership (catalogByAsin never adds rows)", () => {
  const rows = buildOwnershipRows({ marketCountry: "US", accountSkuDirectory: [], catalogByAsin: { ASIN1: { brand: "X" }, ASIN2: {} } }, []);
  assert.equal(rows.length, 0, "catalog presence alone proves no account ownership");
});

let failures = 0;
for (const t of tests) {
  try { t.fn(); passed += 1; out("  ok  " + t.name); }
  catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
}
out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
if (failures) process.exitCode = 1;
