// Campaign -> Brand mapping BACKEND FOUNDATION regressions (offline; ZERO network/DB/DataDoe).
//
// Three layers:
//  (1) PURE directory/authority/brand-resolution (campaign-directory.js): identity is stable across name/status
//      changes; a nullable Ads profile cannot duplicate an identity; marketplace/profile isolation; UK<->GB canonical;
//      newly observed campaign is Unmapped; empty history -> []; rename preserves the mapping; unknown brand fails closed.
//  (2) API-BOUNDARY (api/campaign-brand-mapping.js) with mocked deps: capability gate (admin bypass), cross-account
//      isolation, unknown-campaign / unknown-brand / conflicting-duplicate rejected BEFORE any write, bulk atomicity,
//      correct single assign/change/clear write + audit, and NO DataDoe/permission-mutation path.
//  (3) MIGRATION static invariants (20260915): RLS on, service-role-only writes, no direct authenticated table access,
//      capability default false, RPC security-definer + service-role-only execute, constraints + control-char guards,
//      and it touches NO existing table / scheduler / report.
// 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { handler } from "../api/campaign-brand-mapping.js";
import { assertAccountAccess } from "../lib/server/supabase.js";
import {
  buildCampaignDirectory, buildCampaignAuthority, campaignIdentityKey,
  canonicalMarketplace, normalizeAdsProfile, resolveTrustedBrand,
} from "../lib/server/reports/campaign-directory.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- fixtures --------------------------------------------------------------
// Durable campaign rows (as ads_daily_source_rows for source_key 'campaign-performance-v1'). C1 is renamed across two
// dates (identity must stay stable); C2 has a NULL profile; C3 is a UK row (canonicalizes to GB).
const rowsA = () => [
  { marketplace_country_code: "US", campaign_id: "C1", campaign_type: "SP", currency: "USD", metric_date: "2026-08-01",
    dimensions: { amazon_ads_profile_id: "P1", ad_campaign_name: "Old Name", ad_campaign_status: "enabled", ad_campaign_budget_amount: "40", ad_campaign_budget_currency: "USD" } },
  { marketplace_country_code: "US", campaign_id: "C1", campaign_type: "SP", currency: "USD", metric_date: "2026-08-10",
    dimensions: { amazon_ads_profile_id: "P1", ad_campaign_name: "New Name", ad_campaign_status: "paused", ad_campaign_budget_amount: "55", ad_campaign_budget_currency: "USD" } },
  { marketplace_country_code: "US", campaign_id: "C2", campaign_type: "SB", currency: "USD", metric_date: "2026-08-05",
    dimensions: { amazon_ads_profile_id: null, ad_campaign_name: "Bravo Camp", ad_campaign_status: "enabled" } },
  { marketplace_country_code: "GB", campaign_id: "C3", campaign_type: "SP", currency: "GBP", metric_date: "2026-08-06",
    dimensions: { amazon_ads_profile_id: "P9", ad_campaign_name: "UK Camp", ad_campaign_status: "enabled" } },
];
const trustedA = () => [{ key: "acme", display: "Acme" }, { key: "bravo", display: "Bravo Co" }];

function fakeRes() { return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }

// deps with call recorders. `caps` = { [userId]: Set(accountId) } capability grants. `admin` marks the access role.
function makeDeps(over = {}) {
  const calls = { record: [], bulk: [], audit: [] };
  const caps = over.caps || {};
  const durable = over.durable || { A: rowsA() };
  const mappings = over.mappings || { A: [] };
  const trusted = over.trusted || { A: trustedA() };
  const deps = {
    getDashboardAccess: async () => over.access || { userId: "u1", email: "u@x.com", role: "member", accountIds: over.accountIds || ["A"] },
    assertAccountAccess, // the REAL canonical gate (checks access.accountIds / admin)
    orgFingerprint: () => "org-fp",
    getCampaignMappingCapability: async ({ accountId, userId }) => Boolean(caps[userId] && caps[userId].has(accountId)),
    getCampaignPerformanceRows: async ({ accountId }) => { if (over.durableThrows) throw new Error("db"); return durable[accountId] || []; },
    getCampaignBrandMappings: async ({ accountId }) => mappings[accountId] || [],
    getTrustedAccountBrands: async ({ accountId }) => { if (over.trustedThrows) throw new Error("db"); return trusted[accountId] || []; },
    recordCampaignBrandMapping: async (a) => { calls.record.push(a); return { ...a, action: a.brandKey ? "ASSIGN" : "CLEAR" }; },
    recordCampaignBrandMappingBulk: async (a) => { calls.bulk.push(a); return { applied: a.rows.length }; },
    insertAuditLog: async (a) => { calls.audit.push(a); },
  };
  return { deps, calls };
}
const noWrites = (calls, label) => {
  assert.equal(calls.record.length, 0, `${label}: single RPC not called`);
  assert.equal(calls.bulk.length, 0, `${label}: bulk RPC not called`);
  assert.equal(calls.audit.length, 0, `${label}: audit not called`);
};

/* ================= (1) PURE directory / authority / brand ================= */

test("R1. identity is STABLE across a campaign name+status change (one entry, latest metadata)", () => {
  const dir = buildCampaignDirectory({ durableRows: rowsA(), mappingRows: [] });
  const c1 = dir.filter((c) => c.campaignId === "C1");
  assert.equal(c1.length, 1, "renamed campaign collapses to ONE directory entry");
  assert.equal(c1[0].campaignName, "New Name", "latest observed name wins");
  assert.equal(c1[0].campaignStatus, "paused", "latest observed status wins");
  assert.equal(c1[0].firstObservedDate, "2026-08-01");
  assert.equal(c1[0].lastObservedDate, "2026-08-10");
  assert.equal(c1[0].budgetAmount, 55);
  passed += 1;
});

test("R2. a NULLABLE Ads profile cannot create a duplicate identity ('' deterministic)", () => {
  const rows = [
    { marketplace_country_code: "US", campaign_id: "CX", metric_date: "2026-08-01", dimensions: { amazon_ads_profile_id: null, ad_campaign_name: "n1" } },
    { marketplace_country_code: "US", campaign_id: "CX", metric_date: "2026-08-02", dimensions: { amazon_ads_profile_id: "", ad_campaign_name: "n2" } },
  ];
  assert.equal(buildCampaignDirectory({ durableRows: rows }).length, 1, "null and '' profile are the SAME identity");
  assert.equal(normalizeAdsProfile(null), ""); assert.equal(normalizeAdsProfile("  "), "");
  passed += 1;
});

test("R4. same campaignId in different marketplaces / profiles is ISOLATED", () => {
  const rows = [
    { marketplace_country_code: "US", campaign_id: "C", metric_date: "2026-08-01", dimensions: { amazon_ads_profile_id: "P1" } },
    { marketplace_country_code: "DE", campaign_id: "C", metric_date: "2026-08-01", dimensions: { amazon_ads_profile_id: "P1" } },
    { marketplace_country_code: "US", campaign_id: "C", metric_date: "2026-08-01", dimensions: { amazon_ads_profile_id: "P2" } },
  ];
  assert.equal(buildCampaignAuthority(rows).size, 3, "marketplace AND profile are part of identity");
  passed += 1;
});

test("R-UKGB. UK and GB canonicalize to ONE identity (project canonical helper)", () => {
  assert.equal(canonicalMarketplace("UK"), canonicalMarketplace("GB"));
  const k1 = campaignIdentityKey({ marketplace: "UK", adsProfileId: "P", campaignId: "C" });
  const k2 = campaignIdentityKey({ marketplace: "GB", adsProfileId: "P", campaignId: "C" });
  assert.equal(k1, k2, "UK/GB map to the same campaign identity");
  passed += 1;
});

test("R18. a newly observed campaign with no mapping is Unmapped", () => {
  const dir = buildCampaignDirectory({ durableRows: rowsA(), mappingRows: [] });
  assert.ok(dir.every((c) => c.mapped === false && c.brandKey === ""), "every campaign is Unmapped when no mappings exist");
  passed += 1;
});

test("R17. a rename PRESERVES the mapping (mapping joins by identity, not name)", () => {
  const mappingRows = [{ marketplace: "US", ads_profile_id: "P1", ad_campaign_id: "C1", canonical_brand_key: "acme", brand_display_name: "Acme", mapping_source: "MANUAL", updated_at: "t" }];
  const dir = buildCampaignDirectory({ durableRows: rowsA(), mappingRows });
  const c1 = dir.find((c) => c.campaignId === "C1");
  assert.equal(c1.campaignName, "New Name", "shows the renamed campaign");
  assert.equal(c1.brandKey, "acme", "mapping survives the rename");
  assert.equal(c1.mapped, true);
  passed += 1;
});

test("R19. empty durable history returns an empty directory (no fabrication)", () => {
  assert.deepEqual(buildCampaignDirectory({ durableRows: [], mappingRows: [] }), []);
  assert.deepEqual(buildCampaignDirectory({}), []);
  assert.equal(buildCampaignAuthority([]).size, 0);
  passed += 1;
});

test("R-BRAND. resolveTrustedBrand: valid (case-insensitive) / unknown -> null / blank -> clear", () => {
  assert.deepEqual(resolveTrustedBrand("ACME", trustedA()), { key: "acme", display: "Acme" });
  assert.equal(resolveTrustedBrand("nope", trustedA()), null, "unknown brand fails closed");
  assert.deepEqual(resolveTrustedBrand("", trustedA()), { clear: true });
  passed += 1;
});

/* ================= (2) API-BOUNDARY ================= */

test("R6. a member WITHOUT the capability gets 403 + zero writes (assign)", async () => {
  const { deps, calls } = makeDeps({ caps: {} });
  const res = fakeRes();
  await handler({ method: "POST", body: { accountId: "A", kind: "assign", marketplace: "US", campaignId: "C1", brand: "Acme" } }, res, deps);
  assert.equal(res.statusCode, 403); noWrites(calls, "no-capability");
  passed += 1;
});

test("R7. a brand-restricted viewer without the capability CANNOT list campaigns (403)", async () => {
  const { deps } = makeDeps({ caps: {} });
  const res = fakeRes();
  await handler({ method: "GET", query: { action: "campaigns", accountId: "A" } }, res, deps);
  assert.equal(res.statusCode, 403, "campaign listing is capability-gated");
  passed += 1;
});

test("R11a. account access WITHOUT the capability -> 403 + zero writes", async () => {
  const { deps, calls } = makeDeps({ caps: {}, accountIds: ["A"] }); // has account access, no capability
  const res = fakeRes();
  await handler({ method: "POST", body: { accountId: "A", kind: "assign", marketplace: "US", adsProfileId: "P1", campaignId: "C1", brand: "Acme" } }, res, deps);
  assert.equal(res.statusCode, 403); noWrites(calls, "access-without-capability");
  passed += 1;
});

test("R12/R13. a STALE capability WITHOUT current account access -> 403 (list AND assign)", async () => {
  // The user still has a capability row for A but their canonical account access to A was revoked (accountIds omits A).
  const capOnly = () => makeDeps({ caps: { u1: new Set(["A"]) }, accountIds: [] });
  let m = capOnly(); let res = fakeRes();
  await handler({ method: "GET", query: { action: "campaigns", accountId: "A" } }, res, m.deps);
  assert.equal(res.statusCode, 403, "revoked account access blocks campaign LISTING even with a stale capability");
  m = capOnly(); res = fakeRes();
  await handler({ method: "POST", body: { accountId: "A", kind: "assign", marketplace: "US", adsProfileId: "P1", campaignId: "C1", brand: "Acme" } }, res, m.deps);
  assert.equal(res.statusCode, 403, "revoked account access blocks MAPPING even with a stale capability");
  noWrites(m.calls, "stale-capability");
  passed += 1;
});

test("R11. BOTH account access AND capability are required (both present -> 200)", async () => {
  const { deps, calls } = makeDeps({ caps: { u1: new Set(["A"]) }, accountIds: ["A"] });
  const res = fakeRes();
  await handler({ method: "POST", body: { accountId: "A", kind: "assign", marketplace: "US", adsProfileId: "P1", campaignId: "C1", brand: "Acme" } }, res, deps);
  assert.equal(res.statusCode, 200); assert.equal(calls.record.length, 1);
  passed += 1;
});

test("R5/R21. an authorized mapper (and an admin) can list + assign for the account", async () => {
  const capable = makeDeps({ caps: { u1: new Set(["A"]) } });
  let res = fakeRes();
  await handler({ method: "GET", query: { action: "campaigns", accountId: "A" } }, res, capable.deps);
  assert.equal(res.statusCode, 200); assert.equal(res.body.campaigns.length, 3);
  res = fakeRes();
  await handler({ method: "POST", body: { accountId: "A", kind: "assign", marketplace: "US", adsProfileId: "P1", campaignId: "C1", brand: "Acme" } }, res, capable.deps);
  assert.equal(res.statusCode, 200); assert.equal(capable.calls.record.length, 1);
  assert.equal(capable.calls.record[0].brandKey, "acme"); assert.equal(capable.calls.record[0].source, "MANUAL");
  assert.equal(capable.calls.audit.length, 1, "assign is audited");
  // admin bypasses the capability entirely.
  const admin = makeDeps({ caps: {}, access: { userId: "adm", email: "a@x.com", role: "admin" } });
  res = fakeRes();
  await handler({ method: "GET", query: { action: "campaigns", accountId: "A" } }, res, admin.deps);
  assert.equal(res.statusCode, 200, "admin lists without a capability grant");
  passed += 1;
});

test("R8/R11. capability is PER-ACCOUNT: capable for A is 403 (zero writes) for B", async () => {
  const { deps, calls } = makeDeps({ caps: { u1: new Set(["A"]) }, durable: { A: rowsA(), B: rowsA() } });
  const res = fakeRes();
  await handler({ method: "POST", body: { accountId: "B", kind: "assign", marketplace: "US", campaignId: "C1", brand: "Acme" } }, res, deps);
  assert.equal(res.statusCode, 403); noWrites(calls, "cross-account");
  passed += 1;
});

test("R9. an unknown campaign is rejected BEFORE any DB mutation (400, zero writes)", async () => {
  const { deps, calls } = makeDeps({ caps: { u1: new Set(["A"]) } });
  const res = fakeRes();
  await handler({ method: "POST", body: { accountId: "A", kind: "assign", marketplace: "US", campaignId: "NOPE", brand: "Acme" } }, res, deps);
  assert.equal(res.statusCode, 400); noWrites(calls, "unknown-campaign");
  passed += 1;
});

test("R10. an unknown brand is rejected BEFORE any DB mutation (400, zero writes)", async () => {
  const { deps, calls } = makeDeps({ caps: { u1: new Set(["A"]) } });
  const res = fakeRes();
  await handler({ method: "POST", body: { accountId: "A", kind: "assign", marketplace: "US", campaignId: "C1", brand: "Ghost" } }, res, deps);
  assert.equal(res.statusCode, 400); noWrites(calls, "unknown-brand");
  passed += 1;
});

test("R12. a single CLEAR removes only the own row (blank brand) + audits", async () => {
  const { deps, calls } = makeDeps({ caps: { u1: new Set(["A"]) } });
  const res = fakeRes();
  await handler({ method: "POST", body: { accountId: "A", kind: "clear", marketplace: "US", campaignId: "C1" } }, res, deps);
  assert.equal(res.statusCode, 200); assert.equal(calls.record.length, 1);
  assert.equal(calls.record[0].brandKey, "", "clear sends a blank brand key"); assert.equal(calls.audit.length, 1);
  passed += 1;
});

test("R13. bulk apply calls the atomic RPC ONCE with all normalized rows + one audit", async () => {
  const { deps, calls } = makeDeps({ caps: { u1: new Set(["A"]) } });
  const res = fakeRes();
  await handler({ method: "POST", body: { accountId: "A", kind: "bulk", rows: [
    { marketplace: "US", adsProfileId: "P1", campaignId: "C1", brand: "Acme" },
    { marketplace: "US", adsProfileId: "", campaignId: "C2", brand: "Bravo" }, // null-profile campaign
    { marketplace: "GB", adsProfileId: "P9", campaignId: "C3", brand: "" }, // clear
  ] } }, res, deps);
  assert.equal(res.statusCode, 200); assert.equal(calls.bulk.length, 1, "exactly one atomic bulk RPC");
  assert.equal(calls.bulk[0].rows.length, 3); assert.equal(calls.audit.length, 1);
  passed += 1;
});

test("R14. ONE invalid bulk row -> ZERO mapping + audit writes", async () => {
  const { deps, calls } = makeDeps({ caps: { u1: new Set(["A"]) } });
  const res = fakeRes();
  await handler({ method: "POST", body: { accountId: "A", kind: "bulk", rows: [
    { marketplace: "US", campaignId: "C1", brand: "Acme" },
    { marketplace: "US", campaignId: "NOPE", brand: "Acme" }, // unknown campaign -> whole apply rejected
  ] } }, res, deps);
  assert.equal(res.statusCode, 400); noWrites(calls, "one-bad-bulk-row");
  passed += 1;
});

test("R15. conflicting duplicate bulk rows (same campaign, different brand) rejected -> zero writes", async () => {
  const { deps, calls } = makeDeps({ caps: { u1: new Set(["A"]) } });
  const res = fakeRes();
  await handler({ method: "POST", body: { accountId: "A", kind: "bulk", rows: [
    { marketplace: "US", campaignId: "C1", brand: "Acme" },
    { marketplace: "US", campaignId: "C1", brand: "Bravo" },
  ] } }, res, deps);
  assert.equal(res.statusCode, 400); noWrites(calls, "conflicting-duplicate");
  passed += 1;
});

test("R-EMPTY. empty durable history -> assign is rejected as unknown campaign (no fabrication)", async () => {
  const { deps, calls } = makeDeps({ caps: { u1: new Set(["A"]) }, durable: { A: [] } });
  const res = fakeRes();
  await handler({ method: "POST", body: { accountId: "A", kind: "assign", marketplace: "US", campaignId: "C1", brand: "Acme" } }, res, deps);
  assert.equal(res.statusCode, 400); noWrites(calls, "empty-history-assign");
  passed += 1;
});

test("R-BRANDS. the available-brands endpoint returns trusted brands ONLY to an authorized mapper", async () => {
  const denied = makeDeps({ caps: {} });
  let res = fakeRes();
  await handler({ method: "GET", query: { action: "brands", accountId: "A" } }, res, denied.deps);
  assert.equal(res.statusCode, 403, "no capability -> no brand disclosure");
  const ok = makeDeps({ caps: { u1: new Set(["A"]) } });
  res = fakeRes();
  await handler({ method: "GET", query: { action: "brands", accountId: "A" } }, res, ok.deps);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body.brands.map((b) => b.key), ["acme", "bravo"]);
  passed += 1;
});

test("R-BRANDS-SCOPE. a SELECTED_BRANDS mapper sees ONLY granted brands; admin/ALL_BRANDS see the full trusted set", async () => {
  // Account A trusts {acme, bravo}. A capability-holding member restricted to {acme} must NOT receive 'bravo'.
  const restrictedAccess = { userId: "u1", email: "u@x", role: "member", accountIds: ["A"], accountGrants: { A: { mode: "SELECTED_BRANDS", brandKeys: ["acme"] } } };
  const restricted = makeDeps({ caps: { u1: new Set(["A"]) }, access: restrictedAccess });
  let res = fakeRes();
  await handler({ method: "GET", query: { action: "brands", accountId: "A" } }, res, restricted.deps);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.brands.map((b) => b.key), ["acme"], "forbidden brand 'bravo' is ABSENT from the mapping dropdown");
  // An explicit ALL_BRANDS grant (capability-holding member) still sees every trusted brand.
  const allAccess = { userId: "u1", email: "u@x", role: "member", accountIds: ["A"], accountGrants: { A: { mode: "ALL_BRANDS", brandKeys: null } } };
  const allb = makeDeps({ caps: { u1: new Set(["A"]) }, access: allAccess });
  res = fakeRes();
  await handler({ method: "GET", query: { action: "brands", accountId: "A" } }, res, allb.deps);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body.brands.map((b) => b.key), ["acme", "bravo"], "ALL_BRANDS unchanged");
  // Admin bypasses the capability gate AND is unrestricted.
  const admin = makeDeps({ caps: {}, access: { userId: "adm", role: "admin", accountIds: ["A"], accountGrants: {} } });
  res = fakeRes();
  await handler({ method: "GET", query: { action: "brands", accountId: "A" } }, res, admin.deps);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body.brands.map((b) => b.key), ["acme", "bravo"], "admin unrestricted");
  passed += 1;
});

/* ================= (3) MIGRATION static invariants + (20/23/24) structure ================= */

const MIG = readFileSync(join(ROOT, "supabase/migrations/20260915_campaign_brand_mapping.sql"), "utf8");
const API = readFileSync(join(ROOT, "api/campaign-brand-mapping.js"), "utf8");

test("R-MIG. RLS + service-role-only ACLs; NO direct authenticated table access", () => {
  for (const t of ["campaign_brand_mapping", "campaign_brand_mapping_audit", "account_campaign_map_grant"]) {
    assert.ok(new RegExp(`alter table public.${t} enable row level security`).test(MIG), `${t} RLS enabled`);
    assert.ok(new RegExp(`revoke all on table public.${t} from public, anon, authenticated, service_role`).test(MIG), `${t} revoked broadly`);
  }
  // mapping + audit are NEVER granted to authenticated (all access via the capability-gated API).
  assert.ok(!/grant [\w, ]*on table public.campaign_brand_mapping to authenticated/.test(MIG), "mapping table not granted to authenticated");
  assert.ok(!/grant [\w, ]*on table public.campaign_brand_mapping_audit to authenticated/.test(MIG), "audit table not granted to authenticated");
  // service_role owns mapping writes.
  assert.ok(/grant select, insert, update, delete on table public.campaign_brand_mapping to service_role/.test(MIG));
  assert.ok(/grant select, insert on table public.campaign_brand_mapping_audit to service_role/.test(MIG));
  passed += 1;
});

test("R-MIG. capability default false; user reads only their OWN grant row", () => {
  assert.ok(/can_manage_campaign_brand_mapping boolean not null default false/.test(MIG), "capability default false");
  assert.ok(/create policy accmg_read_own on public.account_campaign_map_grant for select to authenticated\s*\n\s*using \(user_id = auth.uid\(\)\)/.test(MIG), "own-row read policy");
  passed += 1;
});

test("R-MIG. both RPCs are SECURITY DEFINER + service-role-only execute", () => {
  for (const fn of ["record_campaign_brand_mapping", "record_campaign_brand_mapping_bulk"]) {
    assert.ok(new RegExp(`create or replace function public.${fn}\\b`).test(MIG), `${fn} defined`);
    assert.ok(new RegExp(`grant execute on function public.${fn}\\([^)]*\\) to service_role`).test(MIG), `${fn} execute to service_role`);
    assert.ok(new RegExp(`revoke all on function public.${fn}\\([^)]*\\) from public, anon, authenticated`).test(MIG), `${fn} execute revoked`);
  }
  assert.equal((MIG.match(/security definer/g) || []).length, 2, "exactly the two RPCs are security definer");
  passed += 1;
});

test("R-MIG. constraints: nonblank campaign, action/source enums, control-char + length guards", () => {
  assert.ok(/cbm_campaign_nonblank check \(char_length\(btrim\(ad_campaign_id\)\) > 0\)/.test(MIG));
  assert.ok(/cbm_brand_key_nonblank check \(char_length\(btrim\(canonical_brand_key\)\) > 0\)/.test(MIG));
  assert.ok(/action in \('ASSIGN', 'CHANGE', 'CLEAR'\)/.test(MIG), "audit action enum");
  assert.ok(/mapping_source in \('MANUAL', 'BULK'\)/.test(MIG) && /source in \('MANUAL', 'BULK'\)/.test(MIG), "source enums");
  assert.ok(/!~ '\[\[:cntrl:\]\]'/.test(MIG), "control-char guard present");
  // deterministic ASSIGN/CHANGE/CLEAR from prior state.
  assert.ok(/case when v_prev_key = '' then 'ASSIGN' else 'CHANGE' end/.test(MIG), "assign vs change logic");
  // bulk conflict detection before any write.
  assert.ok(/count\(distinct btrim\(coalesce\(r->>'brand_key',''\)\)\) c/.test(MIG), "bulk conflict detection");
  passed += 1;
});

test("R16/R23/R24. migration touches NO existing table/scheduler/report; a re-sync cannot delete a mapping", () => {
  // Only the three new tables + touch trigger + the two RPCs. It must not alter existing tables (ads/permissions/etc.)
  assert.ok(!/alter table public.ads_daily_source_rows/.test(MIG), "does not alter ads_daily_source_rows");
  assert.ok(!/alter table public.account_permissions/.test(MIG), "does not alter account_permissions");
  assert.ok(!/alter table public.account_brand_grant/.test(MIG), "does not alter account_brand_grant");
  assert.ok(!/drop table|truncate/i.test(MIG), "no destructive statements");
  // No foreign key / cascade from the ads rows into the mapping -> a campaign-performance re-sync (which writes only
  // ads_daily_source_rows) can never delete a mapping row.
  assert.ok(!/references public.ads_daily_source_rows/.test(MIG), "no FK from mapping to ads rows");
  passed += 1;
});

test("R20. no DataDoe export/token path is reachable from this API", () => {
  // Check CODE only (strip comments so prose like "never touches a scheduler" is not a false positive). It reads
  // DataDoe CONNECTION config only (to derive the org fingerprint, like every other read API) -- it must NOT import
  // the DataDoe export engine or call any export/token/usage/scheduler surface.
  const code = API.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/from "\.\.\/lib\/server\/datadoe\.js"/.test(code), "does not import the DataDoe export engine");
  assert.ok(!/from "\.\.\/lib\/server\/datadoe-usage/.test(code), "does not import DataDoe usage/token");
  assert.ok(!/report-publisher|source-worker|report-worker|\/cron\/|runAdsSync|runReport|runSync|createExport|runExport|spendToken/i.test(code), "no scheduler/sync/publish/export call");
  // The ONLY datadoe reference is the connection-config read for the org fingerprint.
  assert.ok(/datadoe-connections\.js/.test(code), "reads only the connection-config for the org fingerprint");
  passed += 1;
});

/* ================= run ================= */
let failures = 0;
(async () => {
  out("campaign-brand-mapping");
  for (const t of tests) {
    try { await t.fn(); out("  ok  " + t.name); }
    catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
  }
  out("\n" + passed + " assertions groups passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
})();
