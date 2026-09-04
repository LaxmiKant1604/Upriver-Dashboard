// F4 regression: api/sku-movement-identifier.js must scope reads AND writes to the caller's PERMITTED brands, not the
// account's whole all-brand evidence. A SELECTED_BRANDS user (permitted = {acme}) must: GET only their brands'
// identifiers; SET/CLEAR only their brands' ASINs; bulk reject atomically if ANY row is outside their brands; and
// fail closed on missing evidence. Admin / ALL_BRANDS (and the gate-not-wired path used by the existing test) behave
// exactly as before. Executes the REAL handler with collaborator assertions. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { handler } from "../api/sku-movement-identifier.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function fakeRes() { return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }

const ROWS = [{ asin: "ASINA", brand: "Acme" }, { asin: "ASING", brand: "Gamma" }];
const IDENTS = { ASINA: "acme-id", ASING: "gamma-id" };

// restricted=true => resolveUserReportScope reports SELECTED_BRANDS with permitted={acme}.
function makeDeps({ restricted = false, snapshot = { payload: { rows: ROWS } } } = {}) {
  const calls = { record: [], bulk: [], audit: [] };
  const deps = {
    getDashboardAccess: async () => ({ userId: "u1", email: "u@example.com", role: restricted ? "member" : "admin" }),
    assertAccountAccess: () => {},
    orgFingerprint: () => "org-fp",
    getTrustedAccountBrands: async () => [{ key: "acme", display: "Acme" }],
    resolveUserReportScope: async () => (restricted
      ? { restricted: true, mode: "SELECTED_BRANDS", brandScope: "ALL_PERMITTED", permittedBrandKeys: new Set(["acme"]) }
      : { restricted: false, mode: "ADMIN", permittedBrandKeys: null }),
    getAccountDirectorySnapshotAccounts: async () => [{ accountId: "A", country: "US" }],
    getLatestReportSnapshotForScope: async () => snapshot,
    getSkuMovementIdentifiers: async () => ({ ...IDENTS }),
    recordSkuMovementIdentifier: async (a) => { calls.record.push(a); return { ...a }; },
    recordSkuMovementIdentifierBulk: async (a) => { calls.bulk.push(a); return { applied: a.rows.length }; },
    insertAuditLog: async (a) => { calls.audit.push(a); },
  };
  return { deps, calls };
}
const GET = () => ({ method: "GET", query: { accountId: "A" } });
const POST = (body) => ({ method: "POST", body: { accountId: "A", ...body } });
const noWrites = (calls, label) => {
  assert.equal(calls.record.length, 0, `${label}: single RPC not called`);
  assert.equal(calls.bulk.length, 0, `${label}: bulk RPC not called`);
  assert.equal(calls.audit.length, 0, `${label}: audit not called`);
};

/* ===== restricted (SELECTED_BRANDS, permitted = {acme}) ===== */
test("GET restricted: returns ONLY permitted-brand identifiers (acme), not gamma", async () => {
  const { deps } = makeDeps({ restricted: true });
  const res = fakeRes();
  await handler(GET(), res, deps);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body.identifiers).sort(), ["ASINA"], "only ASINA returned");
});
test("SET restricted: an unpermitted-brand ASIN (gamma) -> rejected, no write", async () => {
  const { deps, calls } = makeDeps({ restricted: true });
  const res = fakeRes();
  await handler(POST({ kind: "set", childAsin: "ASING", identifier: "x" }), res, deps);
  assert.ok(res.statusCode === 400 || res.statusCode === 403, `expected 4xx, got ${res.statusCode}`);
  noWrites(calls, "set-gamma");
});
test("SET restricted: a permitted-brand ASIN (acme) -> 200, write", async () => {
  const { deps, calls } = makeDeps({ restricted: true });
  const res = fakeRes();
  await handler(POST({ kind: "set", childAsin: "ASINA", identifier: "x" }), res, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.record.length, 1);
});
test("CLEAR restricted: clearing an unpermitted-brand ASIN -> rejected, no write", async () => {
  const { deps, calls } = makeDeps({ restricted: true });
  const res = fakeRes();
  await handler(POST({ kind: "set", childAsin: "ASING", identifier: "" }), res, deps);
  assert.ok(res.statusCode === 400 || res.statusCode === 403, `expected 4xx, got ${res.statusCode}`);
  noWrites(calls, "clear-gamma");
});
test("BULK restricted: one unpermitted row -> atomic 400, zero writes", async () => {
  const { deps, calls } = makeDeps({ restricted: true });
  const res = fakeRes();
  await handler(POST({ kind: "bulk", rows: [{ childAsin: "ASINA", identifier: "a" }, { childAsin: "ASING", identifier: "g" }] }), res, deps);
  assert.equal(res.statusCode, 400);
  noWrites(calls, "bulk-mixed");
});
test("BULK restricted: all permitted -> 200", async () => {
  const { deps, calls } = makeDeps({ restricted: true });
  const res = fakeRes();
  await handler(POST({ kind: "bulk", rows: [{ childAsin: "ASINA", identifier: "a" }] }), res, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.bulk.length, 1);
});

/* ===== unrestricted (admin / ALL_BRANDS) unchanged ===== */
test("GET unrestricted: returns the FULL identifier map (unchanged)", async () => {
  const { deps } = makeDeps({ restricted: false });
  const res = fakeRes();
  await handler(GET(), res, deps);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body.identifiers).sort(), ["ASINA", "ASING"]);
});
test("SET unrestricted: any account ASIN (gamma) -> 200 (unchanged)", async () => {
  const { deps, calls } = makeDeps({ restricted: false });
  const res = fakeRes();
  await handler(POST({ kind: "set", childAsin: "ASING", identifier: "x" }), res, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.record.length, 1);
});
test("CLEAR unrestricted: allowed even with an absent snapshot (SAFE clear preserved)", async () => {
  const { deps, calls } = makeDeps({ restricted: false, snapshot: null });
  const res = fakeRes();
  await handler(POST({ kind: "set", childAsin: "ANY", identifier: "" }), res, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.record.length, 1);
});

let failures = 0;
for (const t of tests) {
  await t.fn().then(() => { passed += 1; out("  ok  " + t.name); }).catch((e) => { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); });
}
out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
if (failures) process.exitCode = 1;
