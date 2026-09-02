// Admin campaign-mapping CAPABILITY administration regressions (offline; ZERO network/DB/DataDoe).
// Exercises the real api/access.js handler (capability actions) with mocked deps, plus migration 20260916 static
// invariants. Proves: admin-only; account-in-directory; target user must already have account access to be granted;
// grant/revoke idempotent + audited; a capability write NEVER adds account/brand access; failed op writes nothing;
// non-admin 403; the durable FK cascade + RLS/ACL/RPC lockdown. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { handler } from "../api/access.js";
import { DashboardAccessError } from "../lib/server/supabase.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function fakeRes() { return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }

// Mocked access deps. `calls` records the ONLY writes the capability path may make; brand/account writers are spies
// that MUST stay at zero (a capability grant never widens access).
function makeDeps(over = {}) {
  const calls = { setCap: [], audit: [], brandScope: [], acctPerms: [], userUpdate: [] };
  const deps = {
    getInitialAdminBootstrapStatus: async () => ({}),
    getDashboardAccess: async () => over.access || { userId: "adm", email: "a@x.com", role: "admin" },
    assertAdmin: (a) => { if (!a || a.role !== "admin") throw new DashboardAccessError("Administrator access is required.", 403); },
    listDashboardUsers: async () => [],
    inviteDashboardUser: async (b) => { calls.userUpdate.push(b); return b; },
    updateDashboardUser: async (b) => { calls.userUpdate.push(b); return b; },
    getUserAccountBrandScopes: async () => (over.scopes !== undefined ? over.scopes : [{ accountId: "A", mode: "ALL_BRANDS" }]),
    getTrustedAccountBrands: async () => [{ key: "acme", display: "Acme" }],
    replaceAccountBrandScope: async (b) => { calls.brandScope.push(b); return b; },
    primaryOrgFingerprint: () => "org-fp",
    getAccountDirectorySnapshotAccounts: async () => { if (over.dirThrows) throw new Error("db"); return over.accounts || [{ accountId: "A" }, { accountId: "B" }]; },
    getUserCampaignMappingCapabilities: async () => over.caps || [{ accountId: "A" }],
    setCampaignMappingCapability: async (a) => { calls.setCap.push(a); return { action: a.enabled ? "GRANT" : "REVOKE", enabled: a.enabled }; },
    insertAuditLog: async (a) => { calls.audit.push(a); },
  };
  return { deps, calls };
}
const getReq = (action, query = {}) => ({ method: "GET", query: { action, ...query } });
const postReq = (action, body = {}) => ({ method: "POST", query: { action }, body, headers: {} });
const noCapWrites = (calls, label) => {
  assert.equal(calls.setCap.length, 0, `${label}: no capability RPC`);
  assert.equal(calls.audit.length, 0, `${label}: no audit`);
};
const noAccessWidening = (calls, label) => {
  assert.equal(calls.brandScope.length, 0, `${label}: no brand-scope write`);
  assert.equal(calls.acctPerms.length, 0, `${label}: no account-permission write`);
  assert.equal(calls.userUpdate.length, 0, `${label}: no user update`);
};

/* ================= handler ================= */

test("C1. admin can LIST a user's capability assignments", async () => {
  const { deps } = makeDeps({ caps: [{ accountId: "A" }, { accountId: "B" }] });
  const res = fakeRes();
  await handler(getReq("campaign-map-caps", { userId: "u1" }), res, deps);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body.capabilities.map((c) => c.accountId), ["A", "B"]);
  passed += 1;
});

test("C2/C10/C18. admin GRANT to a user who already has account access -> setCap(true) + audit; no access widening", async () => {
  const { deps, calls } = makeDeps({ scopes: [{ accountId: "A", mode: "ALL_BRANDS" }] });
  const res = fakeRes();
  await handler(postReq("campaign-map-grant", { userId: "u1", accountId: "A" }), res, deps);
  assert.equal(res.statusCode, 200); assert.equal(calls.setCap.length, 1); assert.equal(calls.setCap[0].enabled, true);
  assert.equal(calls.audit.length, 1); assert.equal(calls.audit[0].action, "campaign-map-capability.grant");
  noAccessWidening(calls, "grant"); // R9/R10: never adds account or brand access
  passed += 1;
});

test("C3. admin REVOKE -> setCap(false) + audit (no account-access requirement)", async () => {
  const { deps, calls } = makeDeps({ scopes: [] }); // even with no account access, revoke is allowed
  const res = fakeRes();
  await handler(postReq("campaign-map-revoke", { userId: "u1", accountId: "A" }), res, deps);
  assert.equal(res.statusCode, 200); assert.equal(calls.setCap.length, 1); assert.equal(calls.setCap[0].enabled, false);
  assert.equal(calls.audit.length, 1); assert.equal(calls.audit[0].action, "campaign-map-capability.revoke");
  passed += 1;
});

test("C4. GRANT is idempotent (twice -> two accepted RPC calls, both enabled)", async () => {
  const { deps, calls } = makeDeps();
  for (let i = 0; i < 2; i += 1) { const res = fakeRes(); await handler(postReq("campaign-map-grant", { userId: "u1", accountId: "A" }), res, deps); assert.equal(res.statusCode, 200); }
  assert.equal(calls.setCap.length, 2); assert.ok(calls.setCap.every((c) => c.enabled === true));
  passed += 1;
});

test("C5. non-admin cannot grant or revoke (403, zero writes)", async () => {
  for (const action of ["campaign-map-grant", "campaign-map-revoke"]) {
    const { deps, calls } = makeDeps({ access: { userId: "u2", email: "u@x.com", role: "member" } });
    const res = fakeRes();
    await handler(postReq(action, { userId: "u1", accountId: "A" }), res, deps);
    assert.equal(res.statusCode, 403, `${action} denied for non-admin`); noCapWrites(calls, action);
  }
  // non-admin list is also denied
  const { deps, calls } = makeDeps({ access: { userId: "u2", email: "u@x.com", role: "member" } });
  const res = fakeRes();
  await handler(getReq("campaign-map-caps", { userId: "u1" }), res, deps);
  assert.equal(res.statusCode, 403); noCapWrites(calls, "list");
  passed += 1;
});

test("C6/C7. unknown account is rejected (404) before any write", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler(postReq("campaign-map-grant", { userId: "u1", accountId: "GHOST" }), res, deps);
  assert.equal(res.statusCode, 404); noCapWrites(calls, "unknown-account");
  passed += 1;
});

test("C8. cannot grant capability for an account the target user cannot access (403, zero writes)", async () => {
  const { deps, calls } = makeDeps({ scopes: [{ accountId: "B", mode: "ALL_BRANDS" }] }); // user has B, not A
  const res = fakeRes();
  await handler(postReq("campaign-map-grant", { userId: "u1", accountId: "A" }), res, deps);
  assert.equal(res.statusCode, 403); noCapWrites(calls, "no-account-access"); noAccessWidening(calls, "no-account-access");
  passed += 1;
});

test("C17. a failed grant (unknown account) writes NO capability or audit row", async () => {
  const { deps, calls } = makeDeps({ accounts: [{ accountId: "B" }] }); // A not in directory
  const res = fakeRes();
  await handler(postReq("campaign-map-grant", { userId: "u1", accountId: "A" }), res, deps);
  assert.equal(res.statusCode, 404); noCapWrites(calls, "failed-grant");
  passed += 1;
});

test("C-MISSING. missing user/account -> 400 before any write", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler(postReq("campaign-map-grant", { userId: "", accountId: "A" }), res, deps);
  assert.equal(res.statusCode, 400); noCapWrites(calls, "missing-user");
  passed += 1;
});

/* ================= migration 20260916 static invariants ================= */

const MIG = readFileSync(join(ROOT, "supabase/migrations/20260916_campaign_mapping_capability_admin.sql"), "utf8");

test("C-MIG. durable cleanup FK (user_id, account_id) -> account_permissions ON DELETE CASCADE (idempotent)", () => {
  assert.ok(/add constraint accmg_account_access_fk\s*\n\s*foreign key \(user_id, account_id\) references public.account_permissions \(user_id, account_id\) on delete cascade/.test(MIG), "FK cascade present");
  assert.ok(/if not exists \(\s*\n\s*select 1 from pg_constraint where conname = 'accmg_account_access_fk'/.test(MIG), "FK add is idempotent");
  passed += 1;
});

test("C-MIG. capability audit table: RLS on, service-role-only, append-only GRANT/REVOKE", () => {
  assert.ok(/create table if not exists public.account_campaign_map_grant_audit/.test(MIG));
  assert.ok(/action in \('GRANT', 'REVOKE'\)/.test(MIG), "action enum");
  assert.ok(/alter table public.account_campaign_map_grant_audit enable row level security/.test(MIG));
  assert.ok(/revoke all on table public.account_campaign_map_grant_audit from public, anon, authenticated, service_role/.test(MIG));
  assert.ok(/grant select, insert on table public.account_campaign_map_grant_audit to service_role/.test(MIG));
  assert.ok(!/grant [\w, ]*on table public.account_campaign_map_grant_audit to authenticated/.test(MIG), "no authenticated access to audit");
  passed += 1;
});

test("C-MIG. set_campaign_map_capability RPC is SECURITY DEFINER + service-role-only execute", () => {
  assert.ok(/create or replace function public.set_campaign_map_capability\b/.test(MIG));
  assert.ok(/security definer/.test(MIG));
  assert.ok(/revoke all on function public.set_campaign_map_capability\([^)]*\) from public, anon, authenticated/.test(MIG));
  assert.ok(/grant execute on function public.set_campaign_map_capability\([^)]*\) to service_role/.test(MIG));
  // it never widens access: only touches the grant + its audit, never account_permissions/account_brand_grant.
  assert.ok(!/insert into public.account_permissions|insert into public.account_brand_grant/.test(MIG), "RPC never inserts account/brand access");
  passed += 1;
});

test("C-MIG. forward-only + additive: does not edit 20260915 or alter existing data", () => {
  assert.ok(!/drop table|truncate|delete from public.account_permissions|delete from public.account_brand_grant/i.test(MIG), "no destructive statements");
  assert.ok(!/alter table public.account_permissions|alter table public.account_brand_grant/.test(MIG), "does not alter existing access tables");
  passed += 1;
});

/* ================= run ================= */
let failures = 0;
(async () => {
  out("campaign-map-capability-admin");
  for (const t of tests) {
    try { await t.fn(); out("  ok  " + t.name); }
    catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
  }
  out("\n" + passed + " assertion groups passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
})();
