// Admin User-Access brand-scope API tests (the real authorization + validation boundary, injected deps, no DB).
// Proves: only an admin may mutate (a non-admin is rejected BEFORE any write); every selected brand is validated
// against the account's TRUSTED membership (an unknown brand -> zero writes); a multi-brand save is all-or-nothing;
// ALL_BRANDS clears; the RPC is called with canonical keys + the acting admin's identity (for the audit).
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { handler } from "../api/access.js";
import { DashboardAccessError } from "../lib/server/supabase.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const test = async (name, fn) => { try { await fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };
const fakeRes = () => { const cap = {}; return { res: { status: (c) => ({ json: (b) => { cap.code = c; cap.body = b; } }) }, cap }; };

// A deps factory. TRUSTED membership for account A = Bebi Born + ACME Corp. `role` sets the caller.
function deps({ role = "admin", writes = [] } = {}) {
  return {
    getInitialAdminBootstrapStatus: async () => ({}),
    getDashboardAccess: async () => ({ userId: "admin1", email: "admin@x.io", role }),
    assertAdmin: (access) => { if (access.role !== "admin") throw new DashboardAccessError("Administrator access is required.", 403); },
    listDashboardUsers: async () => ([]),
    inviteDashboardUser: async () => ({}),
    updateDashboardUser: async () => ({}),
    getUserAccountBrandScopes: async () => ([{ accountId: "A", mode: "SELECTED_BRANDS", brandKeys: ["bebi born"], brandDisplays: ["Bebi Born"] }]),
    getTrustedAccountBrands: async ({ accountId }) => (accountId === "A" ? [{ key: "bebi born", display: "Bebi Born" }, { key: "acme corp", display: "ACME Corp" }] : []),
    replaceAccountBrandScope: async (a) => { writes.push(a); return { mode: a.mode, brand_keys: a.brandKeys }; },
    primaryOrgFingerprint: () => "org-fp",
    _writes: writes,
  };
}
const post = (query, body) => ({ method: "POST", query, body });
const get = (query) => ({ method: "GET", query });

await test("46. a NON-admin brand-scope mutation is rejected BEFORE any write", async () => {
  const writes = []; const d = deps({ role: "viewer", writes }); const { res, cap } = fakeRes();
  await handler(post({ action: "brand-scope" }, { userId: "u2", accountId: "A", mode: "SELECTED_BRANDS", brands: ["Bebi Born"] }), res, d);
  assert.equal(cap.code, 403); assert.equal(writes.length, 0, "zero writes for a non-admin");
});

await test("47/48. an unknown brand (not in the account's trusted membership) -> 400, ZERO writes", async () => {
  const writes = []; const d = deps({ writes }); const { res, cap } = fakeRes();
  await handler(post({ action: "brand-scope" }, { userId: "u2", accountId: "A", mode: "SELECTED_BRANDS", brands: ["Bebi Born", "Not A Real Brand"] }), res, d);
  assert.equal(cap.code, 400); assert.equal(cap.body.rejected, 1); assert.equal(writes.length, 0, "one invalid brand -> nothing written (all-or-nothing)");
});

await test("49. a valid multi-brand save calls the RPC with CANONICAL keys + trusted displays", async () => {
  const writes = []; const d = deps({ writes }); const { res, cap } = fakeRes();
  await handler(post({ action: "brand-scope" }, { userId: "u2", accountId: "A", mode: "SELECTED_BRANDS", brands: ["  bebi   BORN ", { key: "ACME Corp" }] }), res, d);
  assert.equal(cap.code, 200); assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].brandKeys.sort(), ["acme corp", "bebi born"], "keys canonicalized");
  assert.deepEqual(writes[0].brandDisplays.sort(), ["ACME Corp", "Bebi Born"], "displays come from trusted membership");
  assert.equal(writes[0].mode, "SELECTED_BRANDS");
});

await test("50. the RPC is called with the acting admin's identity + org fingerprint (for the audit)", async () => {
  const writes = []; const d = deps({ writes }); const { res, cap } = fakeRes();
  await handler(post({ action: "brand-scope" }, { userId: "u2", accountId: "A", mode: "SELECTED_BRANDS", brands: ["Bebi Born"] }), res, d);
  assert.equal(cap.code, 200);
  assert.equal(writes[0].actorId, "admin1"); assert.equal(writes[0].actorEmail, "admin@x.io"); assert.equal(writes[0].organizationFingerprint, "org-fp");
  assert.equal(writes[0].userId, "u2"); assert.equal(writes[0].accountId, "A");
});

await test("ALL_BRANDS clears selected brands (RPC called with empty key list; no membership validation needed)", async () => {
  const writes = []; const d = deps({ writes }); const { res, cap } = fakeRes();
  await handler(post({ action: "brand-scope" }, { userId: "u2", accountId: "A", mode: "ALL_BRANDS" }), res, d);
  assert.equal(cap.code, 200); assert.equal(writes[0].mode, "ALL_BRANDS"); assert.deepEqual(writes[0].brandKeys, []);
});

await test("SELECTED_BRANDS with no brands -> 400, zero writes", async () => {
  const writes = []; const d = deps({ writes }); const { res, cap } = fakeRes();
  await handler(post({ action: "brand-scope" }, { userId: "u2", accountId: "A", mode: "SELECTED_BRANDS", brands: [] }), res, d);
  assert.equal(cap.code, 400); assert.equal(writes.length, 0);
});

await test("account-brands GET returns ONLY the account's trusted membership (never fabricated)", async () => {
  const d = deps(); const { res, cap } = fakeRes();
  await handler(get({ action: "account-brands", accountId: "A" }), res, d);
  assert.equal(cap.code, 200); assert.deepEqual(cap.body.brands.map((b) => b.key).sort(), ["acme corp", "bebi born"]);
});

await test("user-scopes GET returns the user's current per-account brand scope", async () => {
  const d = deps(); const { res, cap } = fakeRes();
  await handler(get({ action: "user-scopes", userId: "u2" }), res, d);
  assert.equal(cap.code, 200); assert.equal(cap.body.scopes[0].mode, "SELECTED_BRANDS");
});

await test("a non-admin cannot even list users / read scopes (assertAdmin gate)", async () => {
  const d = deps({ role: "viewer" }); const { res, cap } = fakeRes();
  await handler(get({ action: "user-scopes", userId: "u2" }), res, d);
  assert.equal(cap.code, 403);
});

await test("me: a non-admin ALL_BRANDS account is materialized to its account trusted brands (permittedBrandKeys attached)", async () => {
  const d = deps({ role: "viewer" });
  d.getDashboardAccess = async () => ({ userId: "u2", email: "u@x", role: "viewer", accountIds: ["A", "Z"], accountGrants: { A: { mode: "ALL_BRANDS", brandKeys: null }, Z: { mode: "ALL_BRANDS", brandKeys: null } } });
  const { res, cap } = fakeRes();
  await handler(get({ action: "me" }), res, d);
  assert.equal(cap.code, 200);
  assert.deepEqual([...(cap.body.access.accountGrants.A.permittedBrandKeys || [])].sort(), ["acme corp", "bebi born"], "A (ALL_BRANDS) -> A's trusted brands");
  // Account Z has NO trusted membership in this fixture -> resolved with empty set; it still gets a (empty) list, and
  // crucially never inherits A's brands (per-account isolation).
  assert.ok(!(cap.body.access.accountGrants.Z.permittedBrandKeys || []).includes("bebi born"), "Z never receives A's brand");
});

await test("me: an ADMIN receives NO per-account permitted map (unrestricted org-wide, byte-identical)", async () => {
  const d = deps({ role: "admin" });
  d.getDashboardAccess = async () => ({ userId: "admin1", role: "admin", accountIds: ["A"], accountGrants: { A: { mode: "ALL_BRANDS", brandKeys: null } } });
  const { res, cap } = fakeRes();
  await handler(get({ action: "me" }), res, d);
  assert.equal(cap.code, 200);
  assert.ok(!("permittedBrandKeys" in (cap.body.access.accountGrants.A || {})), "admin grant is not narrowed with a permitted map");
});

out("\n" + passed + " assertions passed");
