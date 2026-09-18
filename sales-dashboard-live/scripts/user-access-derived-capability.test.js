// ACCOUNT-SCOPED DERIVED PERMISSIONS regressions (offline; ZERO network/DB/DataDoe).
//
// Proves the business requirement: ACCOUNT ACCESS IS THE SOURCE OF TRUTH. Holding access to an account automatically
// (with NO separate stored grant and NO backfill) derives the account's campaign->brand mapping write capability --
// which in this codebase is the same "brand names/mappings" management + bulk-upload path. Revoking account access
// removes it immediately. Admin-only powers (user administration, Data Sync Center, source fetching, scheduler) stay
// admin-only, and a brand-limited (SELECTED_BRANDS) user's derived write is confined to their permitted brands.
//
// Layers: (1) the derived-capability GATE via the real api/campaign-brand-mapping.js handler with mocked deps and NO
// getCampaignMappingCapability dep at all (proving the separate grant is never consulted); (2) admin-only isolation via
// api/access.js + assertAdmin; (3) pure derivations (report-authorization.js) + the account-permission diff
// (idempotency / isolation); (4) the pure UI account-selector search/selection helpers. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { handler as mappingHandler } from "../api/campaign-brand-mapping.js";
import { handler as accessHandler } from "../api/access.js";
import { assertAccountAccess, assertAdmin, computeAccountPermissionDiff, DashboardAccessError } from "../lib/server/supabase.js";
import { hasAccountAccess, canManageCampaignMapping } from "../lib/server/report-authorization.js";
import { matchesAccountQuery, filterAccounts, accountSelectionCounts, toggleAccountId } from "../src/lib/account-access-select.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function fakeRes() { return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }

// ---- fixtures (campaign identities mirror scripts/campaign-brand-mapping.test.js) ----------------------------------
const rowsA = () => [
  { marketplace_country_code: "US", campaign_id: "C1", campaign_type: "SP", currency: "USD", metric_date: "2026-08-01",
    dimensions: { amazon_ads_profile_id: "P1", ad_campaign_name: "Alpha", ad_campaign_status: "enabled" } },
  { marketplace_country_code: "US", campaign_id: "C2", campaign_type: "SB", currency: "USD", metric_date: "2026-08-05",
    dimensions: { amazon_ads_profile_id: null, ad_campaign_name: "Bravo Camp", ad_campaign_status: "enabled" } },
];
const trustedA = () => [{ key: "acme", display: "Acme" }, { key: "bravo", display: "Bravo Co" }];

// A member's access object. `accountIds` = canonical account membership; `accountGrants` = per-account brand scope.
function member(over = {}) {
  return { userId: "u1", email: "u@x.com", role: "member",
    accountIds: over.accountIds || ["A"], accountGrants: over.accountGrants };
}

// Mapping-handler deps with spy call recorders. DELIBERATELY provides NO getCampaignMappingCapability dep: if the gate
// still consulted a separate stored grant the handler would fail, so a 200 here proves the capability is derived.
function makeMappingDeps(over = {}) {
  const calls = { record: [], bulk: [], audit: [] };
  const durable = over.durable || { A: rowsA(), B: rowsA() };
  const trusted = over.trusted || { A: trustedA(), B: trustedA() };
  const deps = {
    getDashboardAccess: async () => (over.access !== undefined ? over.access : member(over)),
    assertAccountAccess, // the REAL canonical account gate
    orgFingerprint: () => "org-fp",
    getCampaignPerformanceRows: async ({ accountId }) => durable[accountId] || [],
    getCampaignBrandMappings: async ({ accountId }) => (over.mappings && over.mappings[accountId]) || [],
    getTrustedAccountBrands: async ({ accountId }) => trusted[accountId] || [],
    recordCampaignBrandMapping: async (a) => { calls.record.push(a); return { ...a, action: a.brandKey ? "ASSIGN" : "CLEAR" }; },
    recordCampaignBrandMappingBulk: async (a) => { calls.bulk.push(a); return { applied: a.rows.length }; },
    insertAuditLog: async (a) => { calls.audit.push(a); },
  };
  return { deps, calls };
}
const noMapWrites = (calls, label) => {
  assert.equal(calls.record.length, 0, `${label}: no single-mapping write`);
  assert.equal(calls.bulk.length, 0, `${label}: no bulk write`);
};
const assign = (accountId, brand = "Acme", extra = {}) => ({ method: "POST", body: { accountId, kind: "assign", marketplace: "US", adsProfileId: "P1", campaignId: "C1", brand, ...extra } });
const bulk = (accountId, rows) => ({ method: "POST", body: { accountId, kind: "bulk", rows } });

/* =============== (1) DERIVED CAPABILITY: the 14 required scenarios =============== */

test("T1. a newly invited user with Account A access CAN edit A's campaign mappings (200 + one write)", async () => {
  const { deps, calls } = makeMappingDeps({ accountIds: ["A"] });
  const res = fakeRes();
  await mappingHandler(assign("A"), res, deps);
  assert.equal(res.statusCode, 200, "account access alone authorizes the mapping write");
  assert.equal(calls.record.length, 1); assert.equal(calls.record[0].brandKey, "acme");
  passed += 1;
});

test("T2. the same user CAN add/edit/UPLOAD A's brand mappings (bulk apply -> 200 + one atomic bulk write)", async () => {
  const { deps, calls } = makeMappingDeps({ accountIds: ["A"] });
  const res = fakeRes();
  await mappingHandler(bulk("A", [
    { marketplace: "US", adsProfileId: "P1", campaignId: "C1", brand: "Acme" },
    { marketplace: "US", adsProfileId: "", campaignId: "C2", brand: "Bravo" },
  ]), res, deps);
  assert.equal(res.statusCode, 200); assert.equal(calls.bulk.length, 1); assert.equal(calls.bulk[0].rows.length, 2);
  passed += 1;
});

test("T3. NO separate post-invitation grant is required (handler has no capability dep; empty grants -> still 200)", async () => {
  // makeMappingDeps injects NO getCampaignMappingCapability; account access is the only authority consulted.
  const { deps, calls } = makeMappingDeps({ accountIds: ["A"], accountGrants: {} });
  const res = fakeRes();
  await mappingHandler(assign("A"), res, deps);
  assert.equal(res.statusCode, 200, "no second grant needed"); assert.equal(calls.record.length, 1);
  passed += 1;
});

test("T4. an EXISTING account member (explicit ALL_BRANDS grant) receives the same effective capability (200)", async () => {
  const { deps, calls } = makeMappingDeps({ accountIds: ["A"], accountGrants: { A: { mode: "ALL_BRANDS", brandKeys: null } } });
  const res = fakeRes();
  await mappingHandler(assign("A"), res, deps);
  assert.equal(res.statusCode, 200); assert.equal(calls.record.length, 1);
  passed += 1;
});

test("T5. a user WITHOUT Account A access is denied by the server (403 + zero writes) for list, assign AND bulk", async () => {
  for (const req of [{ method: "GET", query: { action: "campaigns", accountId: "A" } }, assign("A"), bulk("A", [{ marketplace: "US", adsProfileId: "P1", campaignId: "C1", brand: "Acme" }])]) {
    const { deps, calls } = makeMappingDeps({ accountIds: [] }); // no access to A
    const res = fakeRes();
    await mappingHandler(req, res, deps);
    assert.equal(res.statusCode, 403, "no account access -> denied"); noMapWrites(calls, "no-access");
  }
  passed += 1;
});

test("T6. a user WITH Account A access is denied for Account B (403 + zero writes)", async () => {
  const { deps, calls } = makeMappingDeps({ accountIds: ["A"] }); // access to A only; B has history
  const res = fakeRes();
  await mappingHandler(assign("B"), res, deps);
  assert.equal(res.statusCode, 403, "access to A never authorizes B"); noMapWrites(calls, "cross-account");
  passed += 1;
});

test("T7. REVOKING Account A access removes BOTH write capabilities (assign AND bulk -> 403)", async () => {
  for (const req of [assign("A"), bulk("A", [{ marketplace: "US", adsProfileId: "P1", campaignId: "C1", brand: "Acme" }])]) {
    const { deps, calls } = makeMappingDeps({ accountIds: [] }); // access revoked
    const res = fakeRes();
    await mappingHandler(req, res, deps);
    assert.equal(res.statusCode, 403); noMapWrites(calls, "revoked");
  }
  passed += 1;
});

test("T8. account access does NOT grant user administration / Data Sync Center / source-fetch / scheduler (admin-only)", async () => {
  // (a) assertAdmin -- the SHARED gate used by api/admin/sync.js (Data Sync Center), api/admin/sources.js (source
  // fetching) and api/sync.js -- rejects a member who has account access.
  assert.throws(() => assertAdmin(member({ accountIds: ["A", "B"] })), (e) => e instanceof DashboardAccessError && e.status === 403);
  assert.doesNotThrow(() => assertAdmin({ role: "admin" }));
  // (b) the user-administration API (api/access.js) denies a member listing users, even one with account access.
  const res = fakeRes();
  await accessHandler({ method: "GET", query: { action: "users" } }, res, { getDashboardAccess: async () => member({ accountIds: ["A"] }), assertAdmin });
  assert.equal(res.statusCode, 403, "user administration is admin-only");
  // (c) the derivation itself never implies admin: it is purely per-account, never org-wide management.
  assert.equal(canManageCampaignMapping(member({ accountIds: ["A"] }), "A"), true);
  assert.equal(hasAccountAccess(member({ accountIds: ["A"] }), "B"), false);
  passed += 1;
});

test("T9. a DIRECT API request cannot bypass account scope (a crafted accountId is re-checked server-side)", async () => {
  // The browser can only assert which account id it wants; the server re-checks it against the token's grants. A user
  // scoped to A who directly POSTs a mapping for B (or Z) is refused -- the request body cannot widen scope.
  for (const target of ["B", "Z-not-a-real-account"]) {
    const { deps, calls } = makeMappingDeps({ accountIds: ["A"] });
    const res = fakeRes();
    await mappingHandler(assign(target), res, deps);
    assert.equal(res.statusCode, 403, `crafted accountId ${target} is rejected`); noMapWrites(calls, "bypass");
  }
  passed += 1;
});

test("T13. invitation resend / update is IDEMPOTENT and never creates duplicate membership (pure diff)", async () => {
  // Re-inviting/re-saving with the same set is a no-op (no add, no remove) -> no duplicate rows can be written.
  const same = computeAccountPermissionDiff(["A", "B"], ["A", "B"]);
  assert.deepEqual(same.toAdd, []); assert.deepEqual(same.toRemove, []);
  // Duplicates / whitespace in the wanted set collapse to a clean set.
  const dedup = computeAccountPermissionDiff(["A", "B"], ["A", " B ", "A", "B"]);
  assert.deepEqual(dedup.normalized, ["A", "B"]); assert.deepEqual(dedup.toAdd, []); assert.deepEqual(dedup.toRemove, []);
  // Adding one account touches ONLY that account.
  const add = computeAccountPermissionDiff(["A"], ["A", "B"]);
  assert.deepEqual(add.toAdd, ["B"]); assert.deepEqual(add.toRemove, []);
  passed += 1;
});

test("T13b. removing ONE account does not disturb the user's OTHER account assignments", async () => {
  const d = computeAccountPermissionDiff(["A", "B", "C"], ["A", "C"]); // drop B only
  assert.deepEqual(d.toRemove, ["B"]); // only B is removed
  assert.deepEqual(d.toAdd, []);       // A and C are in NEITHER list -> untouched (brand scope preserved)
  assert.deepEqual(d.normalized, ["A", "C"]);
  passed += 1;
});

test("T14. existing OWNER/ADMIN behaviour is unchanged (admin bypass; org-wide; unaffected by accountIds)", async () => {
  const { deps, calls } = makeMappingDeps({ access: { userId: "adm", email: "a@x.com", role: "admin", accountIds: [] } });
  const res = fakeRes();
  await mappingHandler(assign("A"), res, deps); // admin has empty accountIds yet still authorized
  assert.equal(res.statusCode, 200, "admin bypasses account scope"); assert.equal(calls.record.length, 1);
  assert.equal(hasAccountAccess({ role: "admin" }, "any-account"), true);
  assert.equal(canManageCampaignMapping({ role: "admin" }, "any-account"), true);
  passed += 1;
});

/* =============== (1b) brand-scope hardening: a SELECTED_BRANDS mapper is confined to permitted brands =============== */

test("SB1. a SELECTED_BRANDS mapper CAN assign a PERMITTED brand (200)", async () => {
  const { deps, calls } = makeMappingDeps({ accountIds: ["A"], accountGrants: { A: { mode: "SELECTED_BRANDS", brandKeys: ["acme"] } } });
  const res = fakeRes();
  await mappingHandler(assign("A", "Acme"), res, deps);
  assert.equal(res.statusCode, 200); assert.equal(calls.record[0].brandKey, "acme");
  passed += 1;
});

test("SB2. a SELECTED_BRANDS mapper CANNOT assign a trusted-but-NON-permitted brand (400, zero writes)", async () => {
  const { deps, calls } = makeMappingDeps({ accountIds: ["A"], accountGrants: { A: { mode: "SELECTED_BRANDS", brandKeys: ["acme"] } } });
  const res = fakeRes();
  await mappingHandler(assign("A", "Bravo"), res, deps); // Bravo is trusted for A but NOT permitted for this user
  assert.equal(res.statusCode, 400, "a brand outside the user's scope is rejected"); noMapWrites(calls, "brand-scope-assign");
  passed += 1;
});

test("SB3. a SELECTED_BRANDS mapper's BULK upload rejects a non-permitted brand (400, zero writes)", async () => {
  const { deps, calls } = makeMappingDeps({ accountIds: ["A"], accountGrants: { A: { mode: "SELECTED_BRANDS", brandKeys: ["acme"] } } });
  const res = fakeRes();
  await mappingHandler(bulk("A", [{ marketplace: "US", adsProfileId: "", campaignId: "C2", brand: "Bravo" }]), res, deps);
  assert.equal(res.statusCode, 400); noMapWrites(calls, "brand-scope-bulk");
  passed += 1;
});

/* ---- brand-scope of the READ + CLEAR paths (regressions the derivation opened; caught by adversarial review) ---- */
// Account A trusts {acme, bravo}; C1(US,P1) is mapped to acme, C2(US,'') is mapped to bravo. User U is limited to acme.
const mapsA = () => ({ A: [
  { marketplace: "US", ads_profile_id: "P1", ad_campaign_id: "C1", canonical_brand_key: "acme", brand_display_name: "Acme", mapping_source: "MANUAL", updated_at: "t" },
  { marketplace: "US", ads_profile_id: "", ad_campaign_id: "C2", canonical_brand_key: "bravo", brand_display_name: "Bravo Co", mapping_source: "MANUAL", updated_at: "t" },
] });
const sbAcme = () => ({ accountIds: ["A"], accountGrants: { A: { mode: "SELECTED_BRANDS", brandKeys: ["acme"] } }, mappings: mapsA() });

test("SB4. GET campaigns HIDES campaigns mapped to a NON-permitted brand from a SELECTED_BRANDS user", async () => {
  const { deps } = makeMappingDeps(sbAcme());
  const res = fakeRes();
  await mappingHandler({ method: "GET", query: { action: "campaigns", accountId: "A" } }, res, deps);
  assert.equal(res.statusCode, 200);
  const shown = res.body.campaigns.map((c) => c.campaignId).sort();
  assert.deepEqual(shown, ["C1"], "only the acme campaign is visible; the bravo campaign C2 is hidden");
  passed += 1;
});

test("SB5. GET mappings returns ONLY the caller's permitted-brand mappings", async () => {
  const { deps } = makeMappingDeps(sbAcme());
  const res = fakeRes();
  await mappingHandler({ method: "GET", query: { action: "mappings", accountId: "A" } }, res, deps);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.mappings.map((m) => m.brandKey), ["acme"], "bravo's mapping is not disclosed");
  passed += 1;
});

test("SB6. a SELECTED_BRANDS user CANNOT CLEAR a campaign mapped to a NON-permitted brand (400, zero writes)", async () => {
  const { deps, calls } = makeMappingDeps(sbAcme());
  const res = fakeRes();
  await mappingHandler({ method: "POST", body: { accountId: "A", kind: "clear", marketplace: "US", adsProfileId: "", campaignId: "C2" } }, res, deps);
  assert.equal(res.statusCode, 400, "clearing bravo's C2 is denied"); noMapWrites(calls, "clear-nonpermitted");
  passed += 1;
});

test("SB7. a SELECTED_BRANDS user CAN clear their OWN permitted-brand campaign (200 + one write)", async () => {
  const { deps, calls } = makeMappingDeps(sbAcme());
  const res = fakeRes();
  await mappingHandler({ method: "POST", body: { accountId: "A", kind: "clear", marketplace: "US", adsProfileId: "P1", campaignId: "C1" } }, res, deps);
  assert.equal(res.statusCode, 200, "clearing their own acme C1 is allowed"); assert.equal(calls.record.length, 1);
  passed += 1;
});

test("SB8. a SELECTED_BRANDS user CANNOT re-assign (steal) a campaign owned by a NON-permitted brand (400)", async () => {
  const { deps, calls } = makeMappingDeps(sbAcme());
  const res = fakeRes();
  // C2 is bravo's; U (acme) tries to re-map it to acme -> blocked even though acme is a permitted target brand.
  await mappingHandler({ method: "POST", body: { accountId: "A", kind: "assign", marketplace: "US", adsProfileId: "", campaignId: "C2", brand: "Acme" } }, res, deps);
  assert.equal(res.statusCode, 400, "cannot overwrite a non-permitted brand's mapping"); noMapWrites(calls, "reassign-steal");
  passed += 1;
});

test("SB9. BULK cannot touch a campaign owned by a NON-permitted brand (400, zero writes)", async () => {
  const { deps, calls } = makeMappingDeps(sbAcme());
  const res = fakeRes();
  await mappingHandler(bulk("A", [{ marketplace: "US", adsProfileId: "", campaignId: "C2", brand: "Acme" }]), res, deps);
  assert.equal(res.statusCode, 400); noMapWrites(calls, "bulk-steal");
  passed += 1;
});

test("SB10. admin + ALL_BRANDS see EVERY campaign/mapping (brand-scope only narrows SELECTED_BRANDS)", async () => {
  for (const access of [{ userId: "adm", role: "admin", accountIds: [], accountGrants: {} }, member({ accountIds: ["A"], accountGrants: { A: { mode: "ALL_BRANDS", brandKeys: null } } })]) {
    const { deps } = makeMappingDeps({ access, mappings: mapsA() });
    const res = fakeRes();
    await mappingHandler({ method: "GET", query: { action: "mappings", accountId: "A" } }, res, deps);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.mappings.map((m) => m.brandKey).sort(), ["acme", "bravo"], "unrestricted callers see all brands");
  }
  passed += 1;
});

/* =============== (3) pure derivations =============== */

test("P1. hasAccountAccess: admin always true; member true for a granted account (via accountIds OR accountGrants)", () => {
  assert.equal(hasAccountAccess({ role: "admin" }, "X"), true);
  assert.equal(hasAccountAccess({ role: "member", accountIds: ["A"] }, "A"), true);
  assert.equal(hasAccountAccess({ role: "member", accountGrants: { A: { mode: "ALL_BRANDS" } } }, "A"), true);
  assert.equal(hasAccountAccess({ role: "member", accountIds: ["A"] }, "B"), false);
  assert.equal(hasAccountAccess({ role: "member", accountIds: ["A"] }, ""), false);
  assert.equal(hasAccountAccess(null, "A"), false);
  passed += 1;
});

test("P2. canManageCampaignMapping mirrors hasAccountAccess exactly (one capability, no parallel flag)", () => {
  const m = { role: "member", accountIds: ["A"] };
  assert.equal(canManageCampaignMapping(m, "A"), true);
  assert.equal(canManageCampaignMapping(m, "B"), false);
  assert.equal(canManageCampaignMapping({ role: "admin" }, "B"), true);
  passed += 1;
});

/* =============== (4) UI account-selector search / selection helpers =============== */

const ACCOUNTS = [
  { id: "acc-111", name: "MeridienMarket", country: "IN", marketplace: "Amazon.in", currency: "INR" },
  { id: "acc-222", name: "Haven&Hue", country: "US", marketplace: "Amazon.com", currency: "USD" },
  { id: "acc-333", name: "Indya Store", country: "CA", marketplace: "Amazon.ca", currency: "CAD" },
];
const ids = (list) => list.map((a) => a.id);

test("T10. search finds accounts by NAME, MARKETPLACE/COUNTRY, CURRENCY and ID (case-insensitive)", () => {
  assert.deepEqual(ids(filterAccounts(ACCOUNTS, { query: "meridien" })), ["acc-111"], "by name");
  assert.deepEqual(ids(filterAccounts(ACCOUNTS, { query: "MERIDIEN" })), ["acc-111"], "case-insensitive");
  assert.deepEqual(ids(filterAccounts(ACCOUNTS, { query: "amazon.com" })), ["acc-222"], "by marketplace");
  assert.deepEqual(ids(filterAccounts(ACCOUNTS, { query: "cad" })), ["acc-333"], "by currency");
  assert.deepEqual(ids(filterAccounts(ACCOUNTS, { query: "acc-222" })), ["acc-222"], "by stable id");
  assert.equal(matchesAccountQuery(ACCOUNTS[0], "IN"), true, "by country code");
  assert.deepEqual(ids(filterAccounts(ACCOUNTS, { query: "" })), ["acc-111", "acc-222", "acc-333"], "empty query -> all");
  assert.deepEqual(ids(filterAccounts(ACCOUNTS, { query: "no-such-account" })), [], "no match -> empty (empty state)");
  passed += 1;
});

test("T11. filtering NEVER loses the selection (hidden-but-selected accounts stay selected)", () => {
  const selected = ["acc-111", "acc-333"];
  // A query that shows only an UNSELECTED account must not touch the selection.
  const visible = filterAccounts(ACCOUNTS, { query: "haven", selectedIds: selected });
  assert.deepEqual(ids(visible), ["acc-222"]);
  assert.deepEqual(selected, ["acc-111", "acc-333"], "selection array is not mutated by filtering");
  assert.deepEqual(accountSelectionCounts(ACCOUNTS, selected), { total: 3, selected: 2 }, "counts stay honest while filtered");
  // Selected-only shows exactly the selection regardless of the (empty) query.
  assert.deepEqual(ids(filterAccounts(ACCOUNTS, { selectedOnly: true, selectedIds: selected })), ["acc-111", "acc-333"]);
  // Toggling is independent of the search text.
  assert.deepEqual(toggleAccountId(selected, "acc-222"), ["acc-111", "acc-333", "acc-222"], "toggle adds");
  assert.deepEqual(toggleAccountId(selected, "acc-111"), ["acc-333"], "toggle removes, others preserved");
  passed += 1;
});

test("T12. saving while filtered preserves the COMPLETE selection, not only the visible rows", () => {
  const selected = ["acc-111", "acc-333"]; // neither is visible under this search
  const visible = filterAccounts(ACCOUNTS, { query: "haven", selectedIds: selected });
  assert.deepEqual(ids(visible), ["acc-222"], "only acc-222 is visible");
  // The value a save would persist is the full selection, independent of what is visible.
  assert.deepEqual(selected, ["acc-111", "acc-333"]);
  assert.equal(accountSelectionCounts(ACCOUNTS, selected).selected, 2, "all selected accounts are counted, not just visible");
  passed += 1;
});

/* ================= run ================= */
let failures = 0;
(async () => {
  out("user-access-derived-capability");
  for (const t of tests) {
    try { await t.fn(); out("  ok  " + t.name); }
    catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
  }
  out("\n" + passed + " assertion groups passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
})();
