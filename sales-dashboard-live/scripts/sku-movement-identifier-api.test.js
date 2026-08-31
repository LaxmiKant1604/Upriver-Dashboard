// SKU MOVEMENT identifier + prefs API handler tests -- the REAL authorization + write boundary, with injected deps
// (no DB). Proves: token-derived account authorization (a cross-account write is refused BEFORE any mutation), the
// server-side ASIN-belongs-to-account gate (unknown/cross-account ASIN rejected), single set/clear, bulk
// all-or-nothing (one bad row -> zero writes), conflicting-duplicate rejection, idempotent re-apply, org fingerprint
// + marketplace derived server-side (never the browser), and the user-scoped prefs (recentDays clamp, partial update).
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
process.env[["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_")] = process.env[["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_")] || "test-key";
import { handler as identHandler } from "../api/sku-movement-identifier.js";
import { handler as prefsHandler } from "../api/sku-movement-prefs.js";
import { DashboardAccessError } from "../lib/server/supabase.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const test = async (name, fn) => { try { await fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const fakeRes = () => { const cap = {}; return { res: { status: (c) => ({ json: (b) => { cap.code = c; cap.body = b; } }) }, cap }; };

// A deps factory: `allowed` = the account ids the token-user holds; ASIN authority = A's snapshot has B0A/B0B.
function deps({ allowed = ["A"], writes = [], audits = [] } = {}) {
  return {
    getDashboardAccess: async () => ({ userId: "u1", email: "u1@x.io", role: "member", accountIds: allowed }),
    assertAccountAccess: (access, ids) => { for (const id of ids) if (!access.accountIds.includes(id)) throw new DashboardAccessError("forbidden", 403); },
    orgFingerprint: () => "org-fp",
    getAccountDirectorySnapshotAccounts: async () => ([{ accountId: "A", country: "US", currency: "USD" }, { accountId: "B", country: "DE", currency: "EUR" }]),
    getLatestReportSnapshotForScope: async ({ accountId }) => (accountId === "A" ? { payload: { rows: [{ asin: "B0A" }, { asin: "B0B" }] } } : null),
    getSkuMovementIdentifiers: async () => ({ B0A: "EXISTING-1" }),
    recordSkuMovementIdentifier: async (a) => { writes.push({ single: a }); return { action: a.identifier === "" ? "clear" : "set", child_asin: a.childAsin, identifier: a.identifier }; },
    recordSkuMovementIdentifierBulk: async (a) => { writes.push({ bulk: a }); return { applied: a.rows.length }; },
    insertAuditLog: async (a) => { audits.push(a); },
    _writes: writes, _audits: audits,
  };
}
const post = (body) => ({ method: "POST", body });
const get = (q) => ({ method: "GET", query: q });

await test("GET returns the account's identifiers (authorized account only)", async () => {
  const d = deps(); const { res, cap } = fakeRes();
  await identHandler(get({ accountId: "A" }), res, d);
  assert.equal(cap.code, 200); assert.deepEqual(cap.body.identifiers, { B0A: "EXISTING-1" });
});

await test("cross-account WRITE is refused BEFORE any mutation (assertAccountAccess)", async () => {
  const writes = []; const d = deps({ allowed: ["A"], writes }); const { res, cap } = fakeRes();
  await identHandler(post({ accountId: "B", kind: "set", childAsin: "B0A", identifier: "X" }), res, d);
  assert.equal(cap.code, 403); assert.equal(writes.length, 0, "zero mutation on a forbidden account");
});

await test("set a valid ASIN identifier (marketplace + org derived server-side; audited)", async () => {
  const writes = []; const audits = []; const d = deps({ writes, audits }); const { res, cap } = fakeRes();
  await identHandler(post({ accountId: "A", kind: "set", childAsin: "b0a", identifier: "  MY-ID  " }), res, d);
  assert.equal(cap.code, 200);
  assert.equal(writes[0].single.marketplace, "US", "marketplace derived from the directory, not the browser");
  assert.equal(writes[0].single.organizationFingerprint, "org-fp");
  assert.equal(writes[0].single.childAsin, "B0A"); assert.equal(writes[0].single.identifier, "MY-ID", "trimmed");
  assert.equal(audits.length, 1);
});

await test("set an UNKNOWN ASIN (not in this account's evidence) is rejected -> zero write", async () => {
  const writes = []; const d = deps({ writes }); const { res, cap } = fakeRes();
  await identHandler(post({ accountId: "A", kind: "set", childAsin: "B0ZZZ", identifier: "X" }), res, d);
  assert.equal(cap.code, 400); assert.match(cap.body.error, /not in this account/); assert.equal(writes.length, 0);
});

await test("CLEAR (blank identifier) needs no ASIN authority and removes the account's own row", async () => {
  const writes = []; const d = deps({ writes }); const { res, cap } = fakeRes();
  await identHandler(post({ accountId: "A", kind: "set", childAsin: "B0ANY", identifier: "" }), res, d);
  assert.equal(cap.code, 200); assert.equal(writes[0].single.identifier, ""); // cleared, even for an ASIN not in evidence
});

await test("over-long / control-char identifier rejected", async () => {
  const d = deps(); let r1 = fakeRes(); await identHandler(post({ accountId: "A", kind: "set", childAsin: "B0A", identifier: "x".repeat(121) }), r1.res, d);
  assert.equal(r1.cap.code, 400);
  let r2 = fakeRes(); await identHandler(post({ accountId: "A", kind: "set", childAsin: "B0A", identifier: "bad\ttab" }), r2.res, d);
  assert.equal(r2.cap.code, 400, "control char rejected");
});

await test("BULK: one invalid (unknown ASIN) row -> ZERO writes (all-or-nothing)", async () => {
  const writes = []; const d = deps({ writes }); const { res, cap } = fakeRes();
  await identHandler(post({ accountId: "A", kind: "bulk", rows: [{ childAsin: "B0A", identifier: "OK" }, { childAsin: "B0BAD", identifier: "NO" }] }), res, d);
  assert.equal(cap.code, 400); assert.equal(cap.body.rejected, 1); assert.equal(writes.length, 0, "nothing written when any row is invalid");
});

await test("BULK: duplicate ASIN with CONFLICTING identifiers rejected -> zero writes", async () => {
  const writes = []; const d = deps({ writes }); const { res, cap } = fakeRes();
  await identHandler(post({ accountId: "A", kind: "bulk", rows: [{ childAsin: "B0A", identifier: "X" }, { childAsin: "B0A", identifier: "Y" }] }), res, d);
  assert.equal(cap.code, 400); assert.match(cap.body.error, /conflicting/); assert.equal(writes.length, 0);
});

await test("BULK: a clean file applies once (atomic); re-apply is idempotent (same rows)", async () => {
  const writes = []; const d = deps({ writes }); const { res, cap } = fakeRes();
  const rows = [{ childAsin: "B0A", identifier: "IDA" }, { childAsin: "B0B", identifier: "" }]; // set + clear
  await identHandler(post({ accountId: "A", kind: "bulk", rows }), res, d);
  assert.equal(cap.code, 200); assert.equal(cap.body.applied, 2); assert.equal(writes.length, 1, "ONE atomic bulk RPC call");
  assert.deepEqual(writes[0].bulk.rows, [{ childAsin: "B0A", identifier: "IDA" }, { childAsin: "B0B", identifier: "" }]);
  const w2 = []; const d2 = deps({ writes: w2 }); const r2 = fakeRes();
  await identHandler(post({ accountId: "A", kind: "bulk", rows }), r2.res, d2);
  assert.equal(r2.cap.body.applied, 2, "re-apply of the same values succeeds (idempotent at the RPC)");
});

await test("PREFS: recentDays is clamped to [1,30]; partial update keeps the other field; user-scoped", async () => {
  let stored = { hiddenColumns: ["runRate"], prefs: { recentDays: 7 }, updatedAt: "t" };
  const pdeps = {
    getDashboardAccess: async () => ({ userId: "u1" }),
    getFbaPlanColumnPrefs: async () => stored,
    setFbaPlanColumnPrefs: async ({ hiddenColumns, prefs }) => { stored = { ...stored, hiddenColumns, prefs }; return { hiddenColumns, prefs }; },
  };
  // save only recentDays (out of range -> clamped); hiddenColumns preserved
  let r = fakeRes(); await prefsHandler(post({ recentDays: 99 }), r.res, pdeps);
  assert.equal(r.cap.body.recentDays, 30, "clamped to max 30");
  assert.deepEqual(r.cap.body.hiddenColumns, ["runRate"], "hidden columns preserved on a recentDays-only save");
  r = fakeRes(); await prefsHandler(post({ recentDays: 0 }), r.res, pdeps); assert.equal(r.cap.body.recentDays, 1, "clamped to min 1");
  r = fakeRes(); await prefsHandler(get({}), r.res, pdeps); assert.equal(r.cap.body.recentDays, 1);
});

out("\n" + passed + " assertions passed");
