// F2 regression: api/fba-plan-config.js must apply the fba-plan capability gate CONSISTENTLY to GET and EVERY POST
// kind. The fba-plan report is DENY_FOR_BRAND_RESTRICTED_USERS, so a SELECTED_BRANDS user (who has account access but
// is denied the report) must get 403 with NO configuration returned and NO mutation -- for settings, sku-horizon,
// warehouse, warehouse-bulk, wdd-weights, lead-time, lead-time-bulk, and the base GET. Admin / ALL_BRANDS behavior is
// unchanged. Executes the REAL handler with collaborator call-count assertions. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { handler } from "../api/fba-plan-config.js";
import { BrandAccessError } from "../lib/server/report-authorization.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function fakeRes() { return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }

// `restricted:true` => resolveUserReportScope throws BrandAccessError for action "fba-plan" (a SELECTED_BRANDS user).
function makeDeps({ restricted }) {
  const calls = { mutate: [], audit: [], scope: 0 };
  const track = (name) => async (a) => { calls.mutate.push(name); return { ok: true, ...(a || {}) }; };
  const deps = {
    getDashboardAccess: async () => ({ userId: "u1", email: "u@example.com", role: restricted ? "member" : "admin" }),
    assertAccountAccess: () => {}, // account access holds; the question is the BRAND capability
    orgFingerprint: () => "org-fp",
    getTrustedAccountBrands: async () => [],
    resolveUserReportScope: async () => {
      calls.scope += 1;
      if (restricted) throw new BrandAccessError("This report is not available for your brand-limited access.", 403);
      return { restricted: false, mode: "ADMIN" };
    },
    getFbaPlanningConfig: async () => ({ settings: { safetyDays: 7 }, overrides: [], warehouse: [], wddWeights: [{ brand_key: "acme", weight_7d: 50 }], leadTimes: [{ child_asin: "ASIN1" }] }),
    getLatestReportSnapshotHydrated: async () => ({ payload: { marketCountry: "US", accountSkus: ["EXIST-1"], accountSkuDirectory: [{ sku: "EXIST-1", childAsin: "ASIN1", marketplace: "US" }], catalogByAsin: { ASIN1: { brand: "Acme" } } } }),
    getSellerWarehouseRows: async () => [],
    getWarehouseOwnershipConflicts: async () => new Set(),
    setFbaPlanningSettings: track("settings"),
    setFbaSkuHorizonOverride: track("sku-horizon"),
    deleteFbaSkuHorizonOverride: track("sku-horizon-clear"),
    recordFbaSellerWarehouse: track("warehouse"),
    recordFbaSellerWarehouseBulk: track("warehouse-bulk"),
    recordFbaWddWeights: track("wdd-weights"),
    recordFbaAsinLeadTime: track("lead-time"),
    recordFbaAsinLeadTimeBulk: track("lead-time-bulk"),
    insertAuditLog: async () => { calls.audit.push(1); },
  };
  return { deps, calls };
}

const GET = (accountId = "A") => ({ method: "GET", query: { accountId } });
const POST = (body) => ({ method: "POST", body });

// Every mutating request kind the endpoint accepts.
const MUTATIONS = [
  ["settings", { kind: "settings", forecastMethod: "three-month", safetyDays: 7 }],
  ["sku-horizon", { kind: "sku-horizon", sku: "EXIST-1", horizonKind: "months", horizonMonths: 3 }],
  ["sku-horizon-clear", { kind: "sku-horizon", sku: "EXIST-1", clear: true }],
  ["warehouse", { kind: "warehouse", marketplace: "US", sku: "EXIST-1", childAsin: "", qty: 5 }],
  ["warehouse-bulk", { kind: "warehouse-bulk", rows: [{ marketplace: "US", sku: "EXIST-1", childAsin: "", qty: 5 }] }],
  ["wdd-weights", { kind: "wdd-weights", brandKey: "acme", w7: 50, w30: 30, w60: 20 }],
  ["lead-time", { kind: "lead-time", childAsin: "ASIN1", productionDays: 10 }],
  ["lead-time-bulk", { kind: "lead-time-bulk", rows: [{ childAsin: "ASIN1", productionDays: 10 }] }],
];

/* ===== DENIAL: a SELECTED_BRANDS user is 403'd with no data + no mutation, on GET and EVERY kind ===== */
test("DENY GET: brand-restricted -> 403, no config body", async () => {
  const { deps } = makeDeps({ restricted: true });
  const res = fakeRes();
  await handler(GET(), res, deps);
  assert.equal(res.statusCode, 403, "GET must 403 for brand-restricted");
  assert.ok(!res.body || res.body.settings === undefined, "no config returned");
});
for (const [name, body] of MUTATIONS) {
  test(`DENY POST ${name}: brand-restricted -> 403, zero mutation, zero audit`, async () => {
    const { deps, calls } = makeDeps({ restricted: true });
    const res = fakeRes();
    await handler(POST({ accountId: "A", ...body }), res, deps);
    assert.equal(res.statusCode, 403, `${name} must 403`);
    assert.equal(calls.mutate.length, 0, `${name}: no mutating RPC`);
    assert.equal(calls.audit.length, 0, `${name}: no audit`);
  });
}

/* ===== PRESERVED: an admin / ALL_BRANDS user is unaffected ===== */
test("ALLOW GET: unrestricted -> 200 with wddWeights/leadTimes present", async () => {
  const { deps } = makeDeps({ restricted: false });
  const res = fakeRes();
  await handler(GET(), res, deps);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.wddWeights) && res.body.wddWeights.length === 1, "wddWeights returned");
  assert.ok(Array.isArray(res.body.leadTimes) && res.body.leadTimes.length === 1, "leadTimes returned");
});
test("ALLOW POST settings: unrestricted -> 200, settings RPC called + audit", async () => {
  const { deps, calls } = makeDeps({ restricted: false });
  const res = fakeRes();
  await handler(POST({ accountId: "A", kind: "settings", horizonKind: "months", horizonMonths: 3, forecastMethod: "three-month", safetyDays: 7 }), res, deps);
  assert.equal(res.statusCode, 200);
  assert.ok(calls.mutate.includes("settings"), "settings RPC called for allowed user");
  assert.equal(calls.audit.length, 1);
});

let failures = 0;
for (const t of tests) {
  await t.fn().then(() => { passed += 1; out("  ok  " + t.name); }).catch((e) => { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); });
}
out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
if (failures) process.exitCode = 1;
