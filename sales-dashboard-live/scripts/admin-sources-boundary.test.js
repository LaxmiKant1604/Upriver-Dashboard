// API-BOUNDARY tests for api/admin/sources.js: execute the REAL handler(req,res,deps) with mocked collaborators and
// the REAL centralized Ads-source authority (active-ads-source.isAdsRegistryKeyRetired). 2026-10-03: ASIN Ads
// (ads-asin-date) is an ADDITIONAL operable source again -- not retired: its PATCH pauses/resumes like every source. On
// THIS code line there is no admin ASIN create path: its POST is delegated to the bucket runtime's card action, which
// refuses every durable-ads family before any I/O (source-status.test.js C-ADS3); ASIN exports are created only by the
// scheduler-v2 asin_ads job's runner. Unauthenticated / non-admin callers keep 401/403.
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy env.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let handler, isAdsRegistryKeyRetired;

function fakeRes() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

// A minimal deadline object; a forged retired action never reaches it (the gate is before runtime construction).
function fakeDeadline() {
  return {
    makeDeadline() { return this; },
    deadlineMs: Date.now() + 60_000, reserveMs: 3000,
    outOfTime: () => false, isDeadlineError: () => false,
    ensureTime: async () => {},
    bound: async (_label, fn) => fn(() => {}),
  };
}

function makeDeps(over = {}) {
  const calls = { audit: [], setSourceControl: [], preflight: [], runtimeBuilt: 0, getSourceControls: 0, getSourceRunStatuses: 0, directory: 0, runCardAction: [] };
  const runtime = {
    makeDeadline: () => fakeDeadline(),
    preflightEvidence: async (a) => { calls.preflight.push(a); if (over.preflightThrows) throw Object.assign(new Error("REACHED_PREFLIGHT"), { code: "REACHED_PREFLIGHT" }); return { evidence: {} }; },
    gatherDurableReadiness: async () => ({ unavailable: "test" }),
    runSourceCardAction: async (a) => { calls.runCardAction.push(a); return { refused: false, continuationRequired: false, cycleId: "cyc12345", globalDrained: true }; },
    run: async () => ({ ran: true }),
    store: { getCycleByBucketDate: async () => null },
  };
  const deps = {
    getDashboardAccess: over.getDashboardAccess || (async () => ({ userId: "admin1" })),
    assertAdmin: over.assertAdmin || (() => {}),
    // The REAL centralized authority (not a fake) drives the gate.
    isAdsRegistryKeyRetired,
    insertAuditLog: async (a) => { calls.audit.push(a); },
    setSourceControl: async (a) => { calls.setSourceControl.push(a); return { ok: true }; },
    getSourceControls: async () => { calls.getSourceControls += 1; return { rows: [], read: "ok" }; },
    getSourceRunStatuses: async () => { calls.getSourceRunStatuses += 1; return { rows: [], read: "ok" }; },
    getAccountDirectoryRows: async () => { calls.directory += 1; return []; },
    getAccountOliQualityCounts: async () => ({}),
    primaryOrganizationFingerprint: () => "org-fp",
    buildBucketSourceSyncRuntime: () => { calls.runtimeBuilt += 1; return runtime; },
  };
  return { deps, calls };
}

const noRetiredIO = (calls, label) => {
  assert.equal(calls.runtimeBuilt, 0, `${label}: no runtime constructed`);
  assert.equal(calls.preflight.length, 0, `${label}: no preflightEvidence / coverage / discovery`);
  assert.equal(calls.audit.length, 0, `${label}: no audit write`);
  assert.equal(calls.setSourceControl.length, 0, `${label}: no control write`);
  assert.equal(calls.runCardAction.length, 0, `${label}: no runSourceCardAction (no DataDoe/create/token)`);
  assert.equal(calls.getSourceControls, 0, `${label}: no statusPayload read`);
  assert.equal(calls.getSourceRunStatuses, 0, `${label}: no statusPayload read`);
  assert.equal(calls.directory, 0, `${label}: no discovery`);
};

test("1+2. admin POST for ads-asin-date is no longer boundary-retired: it is delegated to the runtime (which refuses durable-ads); the endpoint has NO ASIN create path", async () => {
  const { deps, calls } = makeDeps({ preflightThrows: true });
  const res = fakeRes();
  await handler({ method: "POST", body: { bucket: "us", sourceKey: "ads-asin-date" } }, res, deps);
  assert.notEqual(res.body && res.body.error, "SOURCE_RETIRED");
  assert.equal(calls.preflight.length, 1, "delegated to the bucket runtime (bounded here by the preflight sentinel)");
  assert.equal(calls.runCardAction.length, 0);
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../api/admin/sources.js", import.meta.url), "utf8");
  assert.ok(!src.includes("runAsinAdsBucketSlice"), "no admin ASIN create path on this code line");
  const rt = readFileSync(new URL("../lib/server/sync/source-bucket-sync-runtime.js", import.meta.url), "utf8");
  assert.match(rt, /SOURCE_ACTION_ADS_ARCHITECTURE/, "the runtime refuses durable-ads card actions");
});

test("3+4. admin PATCH for ads-asin-date pauses it like every source: setSourceControl + audit, 200 (its OWN control)", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler({ method: "PATCH", body: { sourceKey: "ads-asin-date", paused: true } }, res, deps);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(calls.setSourceControl.length, 1); assert.equal(calls.setSourceControl[0].sourceKey, "ads-asin-date"); assert.equal(calls.setSourceControl[0].paused, true);
  assert.equal(calls.audit.length, 1); assert.equal(calls.audit[0].action, "source.paused");
});

test("5. unauthenticated -> 401 and non-admin -> 403 for the ASIN card: no control write, no paid path", async () => {
  // Unauthenticated: getDashboardAccess throws a 401.
  const un = makeDeps({ getDashboardAccess: async () => { throw Object.assign(new Error("Not authenticated."), { status: 401 }); } });
  const r1 = fakeRes();
  await handler({ method: "POST", body: { bucket: "us", sourceKey: "ads-asin-date" } }, r1, un.deps);
  assert.equal(r1.statusCode, 401);
  assert.notEqual(r1.body.error, "SOURCE_RETIRED", "unauth caller is never told the source is retired");
  noRetiredIO(un.calls, "unauth POST");
  // Non-admin: assertAdmin throws a 403.
  const na = makeDeps({ assertAdmin: () => { throw Object.assign(new Error("Admin only."), { status: 403 }); } });
  const r2 = fakeRes();
  await handler({ method: "PATCH", body: { sourceKey: "ads-asin-date", paused: true } }, r2, na.deps);
  assert.equal(r2.statusCode, 403);
  assert.notEqual(r2.body.error, "SOURCE_RETIRED", "non-admin caller is never told the source is retired");
  assert.equal(na.calls.setSourceControl.length, 0, "non-admin never mutates the control");
});

test("6. legitimate admin PATCH for ads-campaign-date is NOT retired-blocked: setSourceControl + audit called, 200", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler({ method: "PATCH", body: { sourceKey: "ads-campaign-date", paused: true } }, res, deps);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(calls.setSourceControl.length, 1, "the active Campaign control IS written");
  assert.equal(calls.setSourceControl[0].sourceKey, "ads-campaign-date");
  assert.equal(calls.setSourceControl[0].paused, true);
  assert.equal(calls.audit.length, 1, "a normal pause is audited");
  assert.equal(calls.audit[0].action, "source.paused");
});

test("7. normal OLI + Catalog + Listings PATCH controls unchanged (not retired-blocked): control written + audited", async () => {
  for (const sourceKey of ["order-line-items", "product-catalog", "listings"]) {
    const { deps, calls } = makeDeps();
    const res = fakeRes();
    await handler({ method: "PATCH", body: { sourceKey, paused: false } }, res, deps);
    assert.equal(res.statusCode, 200, sourceKey + ": " + JSON.stringify(res.body));
    assert.equal(calls.setSourceControl.length, 1, sourceKey + ": control written");
    assert.equal(calls.audit.length, 1, sourceKey + ": audited");
    assert.equal(calls.audit[0].action, "source.resumed");
  }
});

test("6b. legitimate POST for ads-campaign-date passes the retired gate and REACHES preflightEvidence (not blocked)", async () => {
  const { deps, calls } = makeDeps({ preflightThrows: true }); // sentinel to bound the test at preflight
  const res = fakeRes();
  await handler({ method: "POST", body: { bucket: "us", sourceKey: "ads-campaign-date" } }, res, deps);
  // The retired gate did NOT reject it: the runtime was built and preflightEvidence was reached.
  assert.equal(calls.runtimeBuilt >= 1, true, "runtime constructed for the active Campaign grain");
  assert.equal(calls.preflight.length, 1, "preflightEvidence reached (past the retired gate)");
  assert.equal(res.statusCode, 500, "bounded by the preflight sentinel");
  assert.equal(res.body.error, "REACHED_PREFLIGHT");
});

test("8. the retirement gate uses the REAL centralized authority (nothing retired: ASIN is an additional operable source)", () => {
  assert.equal(isAdsRegistryKeyRetired("ads-asin-date"), false, "ASIN registry grain is operable (runner-only exports), not retired");
  assert.equal(isAdsRegistryKeyRetired("ads-campaign-date"), false, "Campaign registry grain is never retired");
  assert.equal(isAdsRegistryKeyRetired("order-line-items"), false);
  assert.equal(isAdsRegistryKeyRetired("listings"), false);
});

test("7b. Listings inventory cutover: the retired fba-inventory-health card is GONE -- a PATCH for it is refused with the TYPED 409 HEALTH_SOURCE_RETIRED (user-readable, never retryable) with ZERO control write / audit, and a POST sync for it never reaches a runtime / preflight (no Health export can be planned from the Data Sync Center)", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler({ method: "PATCH", body: { sourceKey: "fba-inventory-health", paused: false } }, res, deps);
  assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "HEALTH_SOURCE_RETIRED");
  assert.equal(res.body.retryable, false);
  assert.match(String(res.body.message), /retired/i);
  assert.equal(calls.setSourceControl.length, 0, "no control written");
  assert.equal(calls.audit.length, 0, "no audit");
  const { deps: d2, calls: c2 } = makeDeps();
  const r2 = fakeRes();
  await handler({ method: "POST", body: { bucket: "us", sourceKey: "fba-inventory-health", preview: true } }, r2, d2);
  assert.equal(r2.statusCode, 409, "the retired card cannot be previewed / synced: " + r2.statusCode);
  assert.equal(r2.body.code, "HEALTH_SOURCE_RETIRED");
  assert.equal(r2.body.retryable, false);
  assert.equal(c2.setSourceControl.length, 0);
  assert.ok(!JSON.stringify(r2.body || {}).includes("confirmationToken\":\"") , "no confirmation token is ever issued for it");
});

async function main() {
  out("api/admin/sources boundary proof suite");
  ({ handler } = await import("../api/admin/sources.js"));
  ({ isAdsRegistryKeyRetired } = await import("../lib/server/active-ads-source.js"));
  let failures = 0;
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { failures += 1; out("FAIL  " + t.name); out(String(e && e.stack ? e.stack : e)); }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
}

main();
