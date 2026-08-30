// TRUSTED server-side warehouse-write validation. Proves FORGED requests are rejected: unknown/cross-account SKU,
// conflicting SKU->ASIN, manual-ASIN REMAP of a stored identity, out-of-scope/empty marketplace scope, a stale v2d-4
// snapshot never persisting a browser ASIN, and a bulk with ANY invalid row yielding ok=false so the endpoint returns
// before the atomic RPC (zero writes). 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { buildWarehouseAuthority, validateWarehouseRow, validateWarehouseRows, newManualSkuCandidates } from "../lib/server/reports/warehouse-validation.js";

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

test("existing directory SKU: child ASIN resolved from the directory; a blank browser ASIN is fine", () => {
  const a = buildWarehouseAuthority(V5);
  const r = validateWarehouseRow({ marketplace: "US", sku: "EXIST-1", childAsin: "" }, a);
  assert.equal(r.ok, true);
  assert.equal(r.resolvedChildAsin, "ASIN1");
});

test("FORGED: unknown SKU with a non-catalog ASIN is rejected", () => {
  const a = buildWarehouseAuthority(V5);
  const r = validateWarehouseRow({ marketplace: "US", sku: "HACK-1", childAsin: "ASIN-NOPE" }, a);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(";"), /not in this account's catalog/);
});

test("new MANUAL SKU: child ASIN mandatory + must exist in the catalog + not owned by another account", () => {
  const a = buildWarehouseAuthority(V5);
  assert.equal(validateWarehouseRow({ marketplace: "US", sku: "NEW-1", childAsin: "" }, a).ok, false, "no ASIN -> rejected");
  assert.equal(validateWarehouseRow({ marketplace: "US", sku: "NEW-1", childAsin: "ASIN3" }, a).ok, true, "catalog ASIN, no conflict -> ok");
  assert.equal(validateWarehouseRow({ marketplace: "US", sku: "NEW-1", childAsin: "ASINX" }, a).ok, false, "non-catalog ASIN -> rejected");
});

test("FORGED: conflicting SKU -> ASIN mapping is rejected (directory is authoritative)", () => {
  const a = buildWarehouseAuthority(V5);
  const r = validateWarehouseRow({ marketplace: "US", sku: "EXIST-1", childAsin: "ASIN2" }, a);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(";"), /SKU maps to ASIN1, not ASIN2/);
});

/* ===== Blocker 2: durable + immutable identity ===== */
test("stored identity is IMMUTABLE: a manual SKU keeps its stored ASIN; a remap is rejected", () => {
  const a = buildWarehouseAuthority(V5, { existingWarehouseRows: [{ marketplace: "US", sku: "MAN-1", child_asin: "ASIN3" }] });
  // Same or blank ASIN -> preserved.
  assert.equal(validateWarehouseRow({ marketplace: "US", sku: "MAN-1", childAsin: "" }, a).resolvedChildAsin, "ASIN3");
  assert.equal(validateWarehouseRow({ marketplace: "US", sku: "MAN-1", childAsin: "ASIN3" }, a).ok, true);
  // Remap attempt -> rejected.
  const remap = validateWarehouseRow({ marketplace: "US", sku: "MAN-1", childAsin: "ASIN1" }, a);
  assert.equal(remap.ok, false);
  assert.match(remap.problems.join(";"), /already mapped to ASIN3; remapping requires a reviewed identity correction/);
});

/* ===== Blocker 1: v2d-4 never persists a browser ASIN ===== */
test("v2d-4 fallback: a KNOWN SKU keeps its STORED ASIN or blank -- NEVER the browser ASIN", () => {
  const v4 = { marketCountry: "US", accountSkus: ["EXIST-1"] }; // no directory, no catalog
  // No stored row -> resolves to BLANK (not the caller's ASINX), even though the SKU is a member.
  const a1 = buildWarehouseAuthority(v4);
  const r1 = validateWarehouseRow({ marketplace: "US", sku: "EXIST-1", childAsin: "ASINX" }, a1);
  assert.equal(r1.ok, true);
  assert.equal(r1.resolvedChildAsin, "", "browser ASIN dropped; nothing verified it");
  // Stored identity -> preserved; a stale v2d-4 snapshot cannot change it.
  const a2 = buildWarehouseAuthority(v4, { existingWarehouseRows: [{ marketplace: "US", sku: "EXIST-1", child_asin: "ASIN1" }] });
  const r2 = validateWarehouseRow({ marketplace: "US", sku: "EXIST-1", childAsin: "ASINX" }, a2);
  assert.equal(r2.ok, false, "a v2d-4 snapshot must never authorize an ASIN change");
  assert.match(r2.problems.join(";"), /already mapped to ASIN1/);
});

test("v2d-4 fallback: a NEW (non-member) SKU is rejected (ASIN cannot be catalog-verified)", () => {
  const a = buildWarehouseAuthority({ marketCountry: "US", accountSkus: ["EXIST-1"] });
  const r = validateWarehouseRow({ marketplace: "US", sku: "NEW-9", childAsin: "ASIN3" }, a);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(";"), /refresh the FBA plan/);
});

/* ===== Blocker 3: cross-account isolation ===== */
test("cross-account: a new manual SKU already owned by ANOTHER account is rejected (without naming it)", () => {
  const a = buildWarehouseAuthority(V5, { crossAccountOwnedSkus: new Set(["NEW-1"]) });
  const r = validateWarehouseRow({ marketplace: "US", sku: "NEW-1", childAsin: "ASIN3" }, a);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(";"), /already registered under another account/);
  assert.doesNotMatch(r.problems.join(";"), /account[-_ ]?id|acct-/i, "never leaks which account");
});

test("newManualSkuCandidates: only genuinely new SKUs (not in directory, not already stored) are checked", () => {
  const a = buildWarehouseAuthority(V5, { existingWarehouseRows: [{ marketplace: "US", sku: "MAN-1", child_asin: "ASIN3" }] });
  const cands = newManualSkuCandidates([
    { marketplace: "US", sku: "EXIST-1" }, // in directory -> skip
    { marketplace: "US", sku: "MAN-1" },   // already stored -> skip
    { marketplace: "US", sku: "NEW-2" },   // genuinely new -> check
  ], a);
  assert.deepEqual([...cands], ["NEW-2"]);
});

/* ===== Blocker 4: marketplace scope fail-closed + UK/GB ===== */
test("marketplace: an out-of-scope marketplace is rejected", () => {
  const a = buildWarehouseAuthority(V5);
  assert.equal(validateWarehouseRow({ marketplace: "DE", sku: "EXIST-1", childAsin: "" }, a).ok, false);
});

test("marketplace: EMPTY/malformed allowed scope rejects every set/bulk write (fail closed)", () => {
  const a = buildWarehouseAuthority({ accountSkus: ["EXIST-1"] }); // no marketCountry, no directory -> empty scope
  assert.equal(a.allowedMarketplaces.size, 0);
  const r = validateWarehouseRow({ marketplace: "US", sku: "EXIST-1", childAsin: "" }, a);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(";"), /marketplace scope is unavailable/);
});

test("marketplace: UK and GB are canonically the same", () => {
  const a = buildWarehouseAuthority({ marketCountry: "GB", accountSkus: ["S1"], accountSkuDirectory: [{ sku: "S1", childAsin: "ASIN1", marketplace: "GB" }], catalogByAsin: { ASIN1: {} } });
  assert.equal(validateWarehouseRow({ marketplace: "UK", sku: "S1", childAsin: "" }, a).ok, true, "UK write accepted for a GB-scoped account");
});

test("browser-supplied identity fields (brand/provenance/account) are ignored", () => {
  const a = buildWarehouseAuthority(V5);
  const r = validateWarehouseRow({ marketplace: "US", sku: "HACK", childAsin: "ASINX", brand: "Acme", provenance: "inventory", accountId: "someone-else" }, a);
  assert.equal(r.ok, false);
});

/* ===== bulk all-or-nothing ===== */
test("BULK: any invalid row => ok=false (endpoint returns BEFORE the RPC => zero writes)", () => {
  const a = buildWarehouseAuthority(V5);
  const res = validateWarehouseRows([
    { marketplace: "US", sku: "EXIST-1", childAsin: "", qty: 5 },
    { marketplace: "US", sku: "HACK", childAsin: "ASINX", qty: 9 },
  ], a);
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].sku, "HACK");
});

test("BULK: a clean import resolves ASINs; a duplicate makes it invalid", () => {
  const a = buildWarehouseAuthority(V5);
  const clean = validateWarehouseRows([{ marketplace: "US", sku: "EXIST-1", childAsin: "", qty: 5 }], a);
  assert.equal(clean.ok, true);
  assert.equal(clean.valid[0].childAsin, "ASIN1");
  const dup = validateWarehouseRows([{ marketplace: "US", sku: "EXIST-2", childAsin: "ASIN2", qty: 3 }, { marketplace: "US", sku: "EXIST-2", childAsin: "ASIN2", qty: 8 }], a);
  assert.equal(dup.ok, false);
  assert.match(dup.errors[0].problems.join(";"), /duplicate/);
});

test("no published snapshot => every write is rejected (fail closed)", () => {
  const a = buildWarehouseAuthority(null);
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
