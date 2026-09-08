// API-BOUNDARY tests for api/fba-plan-config.js: execute the real handler with mocked access, snapshot/existing-row
// readers, cross-account ownership probe, audit + single/bulk RPCs. Proves FORGED requests (v2d-4 ASIN change,
// cross-account SKU, manual-ASIN remap, missing marketplace scope, one-invalid-row bulk) and AUTHORITY-READ FAILURES
// (warehouse-identity read throws, ownership probe throws, snapshot read throws) all return BEFORE any write/audit
// RPC. Valid single, valid bulk, and safe clear proceed. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { handler } from "../api/fba-plan-config.js";
import { ownershipKey } from "../lib/server/reports/warehouse-validation.js";

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

function makeDeps(over = {}) {
  const calls = { record: [], bulk: [], audit: [] };
  const deps = {
    getDashboardAccess: async () => ({ userId: "u1", email: "u@example.com" }),
    assertAccountAccess: () => {},
    orgFingerprint: () => "org-fp",
    getFbaPlanningConfig: async () => ({ settings: null, overrides: [], warehouse: [] }),
    setFbaPlanningSettings: async () => ({ ok: true }),
    setFbaSkuHorizonOverride: async () => ({ ok: true }),
    deleteFbaSkuHorizonOverride: async () => ({ ok: true }),
    getLatestReportSnapshotHydrated: async () => { if (over.snapshotThrows) throw new Error("db down"); return "snapshot" in over ? over.snapshot : { payload: V5 }; },
    getSellerWarehouseRows: async () => { if (over.warehouseRowsThrow) throw new Error("db down"); return over.existingRows || []; },
    getWarehouseOwnershipConflicts: async () => { if (over.ownershipThrows) throw new Error("db down"); return new Set(over.crossOwnedKeys || []); },
    recordFbaSellerWarehouse: async (a) => { calls.record.push(a); return { ...a }; },
    recordFbaSellerWarehouseBulk: async (a) => { calls.bulk.push(a); return { applied: a.rows.length }; },
    insertAuditLog: async (a) => { calls.audit.push(a); },
    // Lead-time deps (audit 2026-09-08). No resolveUserReportScope -> capability gate open (admin/ALL_BRANDS parity).
    recordFbaAsinLeadTime: async (a) => { calls.record.push({ leadTime: a }); return { ...a }; },
    recordFbaAsinLeadTimeBulk: async (a) => { calls.leadBulk.push(a); return { applied: a.rows.length }; },
  };
  calls.leadBulk = [];
  return { deps, calls };
}
const post = (body) => ({ method: "POST", body });
const noWrites = (calls, label) => {
  assert.equal(calls.record.length, 0, `${label}: single RPC not called`);
  assert.equal(calls.bulk.length, 0, `${label}: bulk RPC not called`);
  assert.equal(calls.audit.length, 0, `${label}: audit not called`);
};

/* ===== Blocker 1: authority-read failures FAIL CLOSED (5xx, zero writes/audit) ===== */
test("FAIL-CLOSED: warehouse-identity read throws -> 5xx, no write, no audit", async () => {
  const { deps, calls } = makeDeps({ warehouseRowsThrow: true });
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "warehouse", marketplace: "US", sku: "EXIST-1", childAsin: "", qty: 5 }), res, deps);
  assert.ok(res.statusCode >= 500, `expected 5xx, got ${res.statusCode}`);
  noWrites(calls, "warehouse-read-throws");
});

test("FAIL-CLOSED: cross-account ownership probe throws -> 5xx, no write, no audit", async () => {
  const { deps, calls } = makeDeps({ ownershipThrows: true });
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "warehouse-bulk", rows: [{ marketplace: "US", sku: "NEW-X", childAsin: "ASIN3", qty: 5 }] }), res, deps);
  assert.ok(res.statusCode >= 500, `expected 5xx, got ${res.statusCode}`);
  noWrites(calls, "ownership-read-throws");
});

test("FAIL-CLOSED: snapshot read throws -> 5xx, no write, no audit", async () => {
  const { deps, calls } = makeDeps({ snapshotThrows: true });
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "warehouse", marketplace: "US", sku: "EXIST-1", childAsin: "", qty: 5 }), res, deps);
  assert.ok(res.statusCode >= 500, `expected 5xx, got ${res.statusCode}`);
  noWrites(calls, "snapshot-read-throws");
});

test("FAIL-CLOSED: genuinely-absent snapshot (null, not an error) -> 400 refusal, no write", async () => {
  const { deps, calls } = makeDeps({ snapshot: null });
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "warehouse", marketplace: "US", sku: "EXIST-1", childAsin: "", qty: 5 }), res, deps);
  assert.equal(res.statusCode, 400);
  noWrites(calls, "no-snapshot");
});

/* ===== forged single writes ===== */
test("FORGED single: cross-account SKU (same marketplace) -> 400, no write", async () => {
  const { deps, calls } = makeDeps({ crossOwnedKeys: [ownershipKey("US", "NEW-1")] });
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

test("FORGED single: v2d-4 ASIN change of a stored identity -> 400, no write", async () => {
  const { deps, calls } = makeDeps({ snapshot: { payload: { marketCountry: "US", accountSkus: ["EXIST-1"] } }, existingRows: [{ marketplace: "US", sku: "EXIST-1", child_asin: "ASIN1" }] });
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "warehouse", marketplace: "US", sku: "EXIST-1", childAsin: "ASINX", qty: 7 }), res, deps);
  assert.equal(res.statusCode, 400);
  noWrites(calls, "v2d-4 remap");
});

test("FORGED single: missing marketplace scope -> 400, no write", async () => {
  const { deps, calls } = makeDeps({ snapshot: { payload: { accountSkus: ["EXIST-1"] } } });
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "warehouse", marketplace: "US", sku: "EXIST-1", childAsin: "", qty: 5 }), res, deps);
  assert.equal(res.statusCode, 400);
  noWrites(calls, "no-scope");
});

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
test("VALID single: writes the server-RESOLVED ASIN + audits, 200", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "warehouse", marketplace: "US", sku: "EXIST-1", childAsin: "", qty: 12 }), res, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.record.length, 1);
  assert.equal(calls.record[0].childAsin, "ASIN1");
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
  assert.equal(calls.bulk.length, 1);
  assert.equal(calls.bulk[0].rows.find((r) => r.sku === "EXIST-1").childAsin, "ASIN1");
  assert.equal(calls.audit.length, 1);
});

test("SAFE clear: deletes the account's own row without identity validation, 200", async () => {
  const { deps, calls } = makeDeps({ snapshot: null });
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "warehouse", marketplace: "US", sku: "ANY", clear: true }), res, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.record.length, 1);
  assert.equal(calls.record[0].action, "clear");
  assert.equal(calls.record[0].qty, null);
});

/* ===== lead-time bulk import: note forwarding + real-date rejection + atomicity (audit 2026-09-08) ===== */
test("LEAD-TIME BULK: notes are FORWARDED to the RPC (childAsin + days + eta + note)", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "lead-time-bulk", rows: [
    { childAsin: "ASIN1", production: 5, shipping: 10, awd: 3, safety: 7, inboundEta: "2026-01-15", note: "keep this note" },
  ] }), res, deps);
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(calls.leadBulk.length, 1, "bulk RPC called once");
  const row = calls.leadBulk[0].rows[0];
  assert.equal(row.childAsin, "ASIN1");
  assert.equal(row.note, "keep this note", "the note reached the RPC row (was dropped before this fix)");
  assert.equal(calls.audit.length, 1);
});

test("LEAD-TIME BULK: an impossible inbound_eta (2026-02-30) is rejected 400, ZERO writes/audit (atomic)", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "lead-time-bulk", rows: [
    { childAsin: "ASIN1", production: 5, shipping: 10, awd: 3, safety: 7, inboundEta: "2026-01-15", note: "ok" },
    { childAsin: "ASIN3", production: 4, shipping: 8, awd: 2, safety: 5, inboundEta: "2026-02-30", note: "bad date" },
  ] }), res, deps);
  assert.equal(res.statusCode, 400, "impossible date rejected");
  assert.match(res.body.error, /real date/);
  assert.equal(calls.leadBulk.length, 0, "no bulk write");
  assert.equal(calls.audit.length, 0, "no audit");
});

test("LEAD-TIME BULK: an ASIN not in the account catalog rejects the WHOLE import (atomic), zero writes", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "lead-time-bulk", rows: [
    { childAsin: "ASIN1", production: 5, shipping: 10, awd: 3, safety: 7, inboundEta: "", note: "" },
    { childAsin: "NOTMINE", production: 1, shipping: 1, awd: 1, safety: 1, inboundEta: "", note: "" },
  ] }), res, deps);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /not in this account's catalog/);
  assert.equal(calls.leadBulk.length, 0, "atomic: zero writes though one row was valid");
});

test("LEAD-TIME single: startedDate must be a REAL date to start a countdown (2026-13-01 rejected, no write)", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "lead-time", childAsin: "ASIN1", action: "start", startedDate: "2026-13-01", production: 5, shipping: 10, awd: 3 }), res, deps);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /real date/);
  assert.equal(calls.record.length, 0);
});

let failures = 0;
for (const t of tests) {
  await t.fn().then(() => { passed += 1; out("  ok  " + t.name); }).catch((e) => { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); });
}
out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
if (failures) process.exitCode = 1;
