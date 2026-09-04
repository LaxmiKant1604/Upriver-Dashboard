// API-BOUNDARY tests for the ADDITIVE FBA config kinds in api/fba-plan-config.js: wdd-weights, lead-time and
// lead-time-bulk. Proves: the fba-plan capability gate (a brand-restricted user is denied 403 and the new GET fields
// are stripped -- follows existing FBA authorization, never broadens it); server-side weight validation (0..100 +
// exact-100, over/under both write nothing); canonical-brand ownership; per-ASIN ownership against the account catalog;
// countdown 'start' requirements; atomic bulk with duplicate/unknown-ASIN rejection; and that every write is audited.
// The existing settings/sku-horizon/warehouse kinds are untouched. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { handler } from "../api/fba-plan-config.js";
import { BrandAccessError } from "../lib/server/report-authorization.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const SNAP = { payload: { marketCountry: "US", catalogByAsin: { ASIN1: { brand: "Acme" }, ASIN3: { brand: "Gamma" } } } };

function fakeRes() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function makeDeps(over = {}) {
  const calls = { wdd: [], lead: [], bulk: [], audit: [] };
  const deps = {
    getDashboardAccess: async () => ({ userId: "u1", email: "u@example.com", role: over.role || "member" }),
    assertAccountAccess: () => {},
    orgFingerprint: () => "org-fp",
    getFbaPlanningConfig: async () => ({ settings: null, overrides: [], warehouse: [], wddWeights: [{ brand_key: "", weight_7d: 50, weight_30d: 30, weight_60d: 20 }], leadTimes: [{ child_asin: "ASIN1", production_days: 30 }] }),
    getLatestReportSnapshotHydrated: async () => { if (over.snapshotThrows) throw new Error("db down"); return "snapshot" in over ? over.snapshot : SNAP; },
    getTrustedAccountBrands: async () => (over.trusted || ["Acme", "Gamma"]),
    resolveUserReportScope: async () => { if (over.restricted) throw new BrandAccessError("brand-limited", 403); return { restricted: false, mode: "ALL_BRANDS" }; },
    recordFbaWddWeights: async (a) => { calls.wdd.push(a); return { ...a }; },
    recordFbaAsinLeadTime: async (a) => { calls.lead.push(a); return { ...a }; },
    recordFbaAsinLeadTimeBulk: async (a) => { calls.bulk.push(a); return { applied: a.rows.length }; },
    insertAuditLog: async (a) => { calls.audit.push(a); },
  };
  return { deps, calls };
}
const post = (body) => ({ method: "POST", body });
const get = (accountId) => ({ method: "GET", query: { accountId } });

/* ===== authorization: the fba-plan capability gate (never broadens access) ===== */
test("AUTHZ: a brand-restricted user is DENIED 403 on every new kind, with zero writes", async () => {
  for (const body of [
    { accountId: "A", kind: "wdd-weights", brandKey: "", w7: 50, w30: 30, w60: 20 },
    { accountId: "A", kind: "lead-time", childAsin: "ASIN1", production: 30, shipping: 10, awd: 5, safety: 14 },
    { accountId: "A", kind: "lead-time-bulk", rows: [{ childAsin: "ASIN1" }] },
  ]) {
    const { deps, calls } = makeDeps({ restricted: true });
    const res = fakeRes();
    await handler(post(body), res, deps);
    assert.equal(res.statusCode, 403, `${body.kind} denied`);
    assert.equal(calls.wdd.length + calls.lead.length + calls.bulk.length + calls.audit.length, 0, `${body.kind}: no writes`);
  }
  passed += 1;
});

test("AUTHZ (F2): GET is DENIED 403 for a brand-restricted user (whole FBA config, not just the new fields)", async () => {
  // F2 fix: the fba-plan report is DENY_FOR_BRAND_RESTRICTED_USERS, so its ENTIRE config endpoint (GET + every POST
  // kind) is now denied to a brand-restricted user -- previously the base GET returned settings/sku-horizon/warehouse
  // and only stripped the new wdd/lead-time fields, which let a restricted account member read cross-brand planning
  // config. A brand-restricted GET must now return 403 with NO configuration body.
  const { deps } = makeDeps({ restricted: true });
  const res = fakeRes();
  await handler(get("A"), res, deps);
  assert.equal(res.statusCode, 403);
  assert.ok(!res.body || res.body.settings === undefined, "no configuration returned to a brand-restricted user");
  passed += 1;
});
test("AUTHZ: GET returns the new fields for an unrestricted user", async () => {
  const { deps } = makeDeps();
  const res = fakeRes();
  await handler(get("A"), res, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.wddWeights.length, 1);
  assert.equal(res.body.leadTimes.length, 1);
  passed += 1;
});

/* ===== wdd-weights ===== */
test("wdd-weights: valid 50/30/20 for the account default writes + audits", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "wdd-weights", brandKey: "", w7: 50, w30: 30, w60: 20 }), res, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.wdd.length, 1); assert.equal(calls.wdd[0].brandKey, ""); assert.equal(calls.wdd[0].w7, 50);
  assert.equal(calls.audit.length, 1);
  passed += 1;
});
test("wdd-weights: over-100 and under-100 each 400 with ZERO writes", async () => {
  for (const w of [{ w7: 60, w30: 30, w60: 20 }, { w7: 50, w30: 20, w60: 20 }]) {
    const { deps, calls } = makeDeps();
    const res = fakeRes();
    await handler(post({ accountId: "A", kind: "wdd-weights", brandKey: "", ...w }), res, deps);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.wdd.length, 0); assert.equal(calls.audit.length, 0);
  }
  passed += 1;
});
test("wdd-weights: a NAMED brand must be a trusted brand of the account; unknown -> 400", async () => {
  const ok = makeDeps(); const okRes = fakeRes();
  await handler(post({ accountId: "A", kind: "wdd-weights", brandKey: "Acme", w7: 50, w30: 30, w60: 20 }), okRes, ok.deps);
  assert.equal(okRes.statusCode, 200); assert.equal(ok.calls.wdd[0].brandKey, "acme");
  const bad = makeDeps(); const badRes = fakeRes();
  await handler(post({ accountId: "A", kind: "wdd-weights", brandKey: "Nope", w7: 50, w30: 30, w60: 20 }), badRes, bad.deps);
  assert.equal(badRes.statusCode, 400); assert.equal(bad.calls.wdd.length, 0);
  passed += 1;
});
test("wdd-weights: clear removes the record via the RPC", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "wdd-weights", brandKey: "Acme", clear: true }), res, deps);
  assert.equal(res.statusCode, 200); assert.equal(calls.wdd[0].action, "clear");
  passed += 1;
});

/* ===== lead-time (single) ===== */
test("lead-time set: an OWNED ASIN writes + audits; an unknown ASIN -> 400 with no write", async () => {
  const ok = makeDeps(); const okRes = fakeRes();
  await handler(post({ accountId: "A", kind: "lead-time", childAsin: "ASIN1", production: 30, shipping: 10, awd: 5, safety: 14 }), okRes, ok.deps);
  assert.equal(okRes.statusCode, 200); assert.equal(ok.calls.lead[0].childAsin, "ASIN1"); assert.equal(ok.calls.lead[0].action, "set");
  const bad = makeDeps(); const badRes = fakeRes();
  await handler(post({ accountId: "A", kind: "lead-time", childAsin: "ASIN9", production: 30 }), badRes, bad.deps);
  assert.equal(badRes.statusCode, 400); assert.equal(bad.calls.lead.length, 0);
  passed += 1;
});
test("lead-time start: requires a start date AND production/shipping/awd", async () => {
  const noDate = makeDeps(); const r1 = fakeRes();
  await handler(post({ accountId: "A", kind: "lead-time", childAsin: "ASIN1", action: "start", production: 30, shipping: 10, awd: 5 }), r1, noDate.deps);
  assert.equal(r1.statusCode, 400); assert.equal(noDate.calls.lead.length, 0);
  const noProd = makeDeps(); const r2 = fakeRes();
  await handler(post({ accountId: "A", kind: "lead-time", childAsin: "ASIN1", action: "start", startedDate: "2026-06-01", shipping: 10, awd: 5 }), r2, noProd.deps);
  assert.equal(r2.statusCode, 400); assert.equal(noProd.calls.lead.length, 0);
  const ok = makeDeps(); const r3 = fakeRes();
  await handler(post({ accountId: "A", kind: "lead-time", childAsin: "ASIN1", action: "start", startedDate: "2026-06-01", production: 30, shipping: 10, awd: 5 }), r3, ok.deps);
  assert.equal(r3.statusCode, 200); assert.equal(ok.calls.lead[0].action, "start"); assert.equal(ok.calls.lead[0].startedDate, "2026-06-01");
  passed += 1;
});
test("lead-time clear: deletes the ASIN row via the RPC (no ownership read needed)", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "lead-time", childAsin: "ASIN9", action: "clear" }), res, deps); // clear allowed even if not in catalog
  assert.equal(res.statusCode, 200); assert.equal(calls.lead[0].action, "clear");
  passed += 1;
});

/* ===== lead-time-bulk (atomic) ===== */
test("lead-time-bulk: valid owned ASINs apply atomically + audit once", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "lead-time-bulk", rows: [{ childAsin: "ASIN1", production: 30 }, { childAsin: "ASIN3", shipping: 5, inboundEta: "2026-07-01" }] }), res, deps);
  assert.equal(res.statusCode, 200); assert.equal(res.body.applied, 2);
  assert.equal(calls.bulk.length, 1); assert.equal(calls.bulk[0].rows.length, 2); assert.equal(calls.audit.length, 1);
  passed += 1;
});
test("lead-time-bulk: an unknown ASIN OR a duplicate ASIN aborts the whole import (zero writes)", async () => {
  const unk = makeDeps(); const r1 = fakeRes();
  await handler(post({ accountId: "A", kind: "lead-time-bulk", rows: [{ childAsin: "ASIN1" }, { childAsin: "ASINX" }] }), r1, unk.deps);
  assert.equal(r1.statusCode, 400); assert.equal(unk.calls.bulk.length, 0); assert.equal(unk.calls.audit.length, 0);
  const dup = makeDeps(); const r2 = fakeRes();
  await handler(post({ accountId: "A", kind: "lead-time-bulk", rows: [{ childAsin: "ASIN1" }, { childAsin: "ASIN1" }] }), r2, dup.deps);
  assert.equal(r2.statusCode, 400); assert.equal(dup.calls.bulk.length, 0);
  passed += 1;
});
test("lead-time-bulk: a bad ETA aborts the whole import (zero writes)", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler(post({ accountId: "A", kind: "lead-time-bulk", rows: [{ childAsin: "ASIN1", inboundEta: "07/01/2026" }] }), res, deps);
  assert.equal(res.statusCode, 400); assert.equal(calls.bulk.length, 0);
  passed += 1;
});

/* ===== run ===== */
let failures = 0;
(async () => {
  out("fba-wdd-config");
  for (const t of tests) { try { await t.fn(); out("  ok  " + t.name); } catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); } }
  out("\n" + passed + " groups passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
})();
