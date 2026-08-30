// API-BOUNDARY tests for api/fba-plan-config.js: execute the real handler with mocked access, snapshot/existing-row
// readers, cross-account reader, audit + single/bulk RPCs. Proves a FORGED request (v2d-4 ASIN change, cross-account
// SKU, manual-ASIN remap, missing marketplace scope, one-invalid-row bulk) returns BEFORE any write/audit RPC, and
// that valid single, valid bulk, and a safe clear proceed. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { handler } from "../api/fba-plan-config.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const V5 = {
  marketCountry: "US",
  accountSkus: ["EXIST-1"],
  accountSkuDirectory: [{ sku: "EXIST-1", childAsin: "ASIN1", brand: "Acme", marketplace: "US", provenance: "inventory" }],
  catalogByAsin: { ASIN1: { brand: "Acme" }, ASIN3: { brand: "Gamma" } },
};

function fakeRes() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

// Build deps with call-recording spies. `over` customizes the snapshot payload, existing rows, cross-account set.
function makeDeps(over = {}) {
  const calls = { record: [], bulk: [], audit: [], setSettings: [], setHorizon: [], delHorizon: [] };
  const deps = {
    getDashboardAccess: async () => ({ userId: "u1", email: "u@example.com" }),
    assertAccountAccess: () => {},
    orgFingerprint: () => "org-fp",
    getFbaPlanningConfig: async () => ({ settings: null, overrides: [], warehouse: [] }),
    setFbaPlanningSettings: async (a) => { calls.setSettings.push(a); return { ok: true }; },
    setFbaSkuHorizonOverride: async (a) => { calls.setHorizon.push(a); return { ok: true }; },
    deleteFbaSkuHorizonOverride: async (a) => { calls.delHorizon.push(a); return { ok: true }; },
    getLatestReportSnapshotHydrated: async () => ("snapshot" in over ? over.snapshot : { payload: V5 }),
    getSellerWarehouseRows: async () => over.existingRows || [],
    getSkusOwnedByOtherAccounts: async () => new Set(over.crossOwned || []),
    recordFbaSellerWarehouse: async (a) => { calls.record.push(a); return { ...a }; },
    recordFbaSellerWarehouseBulk: async (a) => { calls.bulk.push(a); return { applied: a.rows.length }; },
    insertAuditLog: async (a) => { calls.audit.push(a); },
  };
  return { deps, calls };
}
const post = (body) => ({ method: "POST", body });

const noWrites = (calls, label) => {
  assert.equal(calls.record.length, 0, `${label}: single RPC not called`);
  assert.equal(calls.bulk.length, 0, `${label}: bulk RPC not called`);
  assert.equal(calls.audit.length, 0, `${label}: audit not called`);
};

/* ===== forged single writes: fail BEFORE any write/audit ===== */
test("FORGED single: cross-account SKU -> 400, no write, no audit", async () => {
  const { deps, calls } = makeDeps({ crossOwned: ["NEW-1"] });
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "warehouse", marketplace: "US", sku: "NEW-1", childAsin: "ASIN3", qty: 5 }), res, deps);
  assert.equal(res.statusCode, 400);
  noWrites(calls, "cross-account");
});

test("FORGED single: manual-ASIN REMAP of a stored identity -> 400, no write", async () => {
  const { deps, calls } = makeDeps({ existingRows: [{ marketplace: "US", sku: "MAN-1", child_asin: "ASIN3" }] });
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "warehouse", marketplace: "US", sku: "MAN-1", childAsin: "ASIN1", qty: 5 }), res, deps);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /already mapped to ASIN3/);
  noWrites(calls, "remap");
});

test("FORGED single: v2d-4 snapshot ASIN change of a stored identity -> 400, no write", async () => {
  const { deps, calls } = makeDeps({ snapshot: { payload: { marketCountry: "US", accountSkus: ["EXIST-1"] } }, existingRows: [{ marketplace: "US", sku: "EXIST-1", child_asin: "ASIN1" }] });
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "warehouse", marketplace: "US", sku: "EXIST-1", childAsin: "ASINX", qty: 7 }), res, deps);
  assert.equal(res.statusCode, 400);
  noWrites(calls, "v2d-4 remap");
});

test("FORGED single: missing marketplace scope (empty snapshot scope) -> 400, no write", async () => {
  const { deps, calls } = makeDeps({ snapshot: { payload: { accountSkus: ["EXIST-1"] } } }); // no marketCountry/directory
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "warehouse", marketplace: "US", sku: "EXIST-1", childAsin: "", qty: 5 }), res, deps);
  assert.equal(res.statusCode, 400);
  noWrites(calls, "no-scope");
});

test("FORGED single: unknown SKU with a non-catalog ASIN -> 400, no write", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "warehouse", marketplace: "US", sku: "HACK", childAsin: "ASINX", qty: 5 }), res, deps);
  assert.equal(res.statusCode, 400);
  noWrites(calls, "unknown-sku");
});

/* ===== forged bulk: one invalid row => zero writes/audit ===== */
test("FORGED bulk: one invalid row -> 400, bulk RPC NOT called, no audit", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "warehouse-bulk", rows: [
    { marketplace: "US", sku: "EXIST-1", childAsin: "", qty: 5 },
    { marketplace: "US", sku: "HACK", childAsin: "ASINX", qty: 9 },
  ] }), res, deps);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.rejected, 1);
  noWrites(calls, "bulk-invalid");
});

/* ===== valid writes proceed ===== */
test("VALID single: writes with the server-RESOLVED ASIN + audits, 200", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "warehouse", marketplace: "US", sku: "EXIST-1", childAsin: "", qty: 12 }), res, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.record.length, 1);
  assert.equal(calls.record[0].childAsin, "ASIN1", "server resolved the trusted ASIN");
  assert.equal(calls.record[0].qty, 12);
  assert.equal(calls.audit.length, 1);
});

test("VALID bulk: single atomic RPC once + audit, 200; child ASINs server-resolved", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "warehouse-bulk", rows: [
    { marketplace: "US", sku: "EXIST-1", childAsin: "", qty: 5 },
    { marketplace: "US", sku: "NEW-9", childAsin: "ASIN3", qty: 3 },
  ] }), res, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.bulk.length, 1, "exactly one atomic RPC");
  assert.equal(calls.bulk[0].rows.length, 2);
  assert.equal(calls.bulk[0].rows.find((r) => r.sku === "EXIST-1").childAsin, "ASIN1");
  assert.equal(calls.audit.length, 1);
});

test("SAFE clear: deletes the account's own row without identity validation, 200", async () => {
  const { deps, calls } = makeDeps({ snapshot: null }); // even with no snapshot, a clear is safe
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "warehouse", marketplace: "US", sku: "ANY", clear: true }), res, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.record.length, 1);
  assert.equal(calls.record[0].action, "clear");
  assert.equal(calls.record[0].qty, null);
});

let failures = 0;
for (const t of tests) {
  await t.fn().then(() => { passed += 1; out("  ok  " + t.name); }).catch((e) => { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); });
}
out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
if (failures) process.exitCode = 1;
