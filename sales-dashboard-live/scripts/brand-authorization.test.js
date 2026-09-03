// CENTRAL authorization resolver + capability registry + projection tests (pure, injected membership). Proves the
// account+brand security semantics: admin/ALL_BRANDS unrestricted (byte-identical), SELECTED_BRANDS enforced
// (unknown account/brand 403, denied report 403, permitted-only, membership intersection, canonical keys), the
// access fingerprint changes on every mutation, and the payload projections keep only permitted rows.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  CAPABILITY, REPORT_CAPABILITIES, resolveUserReportScope, accessFingerprint, BrandAccessError,
  isBrandAccessible, requiresScopeAdapter, projectBrandSalesPayload, projectSkuMovementPayload,
  projectBrandDirectoryPayload, filterRowsToBrands, accountBrandPairAuthorized, resolveAuthorizedBrandMap,
} from "../lib/server/report-authorization.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const test = async (name, fn) => { try { await fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };
async function throws403(fn, re) {
  try { await fn(); assert.fail("expected a BrandAccessError"); }
  catch (e) { assert.ok(e instanceof BrandAccessError, "is BrandAccessError: " + e.message); assert.ok(e.status === 403 || e.status === 409, "status " + e.status); if (re) assert.match(e.message, re); }
}

// Trusted membership: account A sells "Bebi Born", "Bebi-Born" (punctuation-distinct!), "ACME Corp". B sells "Zeta".
const TRUSTED = {
  A: [{ key: "bebi born", display: "Bebi Born" }, { key: "bebi-born", display: "Bebi-Born" }, { key: "acme corp", display: "ACME Corp" }],
  B: [{ key: "zeta", display: "Zeta" }],
};
const getTrustedBrands = async ({ accountId }) => TRUSTED[accountId] || [];

const access = (over = {}) => ({
  userId: "u1", role: "viewer", accountIds: ["A", "B"],
  accountGrants: { A: { mode: "ALL_BRANDS", brandKeys: null }, B: { mode: "ALL_BRANDS", brandKeys: null } },
  ...over,
});
const selA = (keys) => access({ accountGrants: { A: { mode: "SELECTED_BRANDS", brandKeys: keys }, B: { mode: "ALL_BRANDS", brandKeys: null } } });

await test("33/34. every known report action is in the registry; brand-accessible ones require an adapter", () => {
  const known = ["brand-sales", "daily", "sku-movement", "brand-view", "brand-view-portfolio", "brand-portfolio",
    "brand-view-brands", "brand-directory", "oli-quality", "sales", "reconciliation", "sku-pl", "keyword-rank",
    "content-changes", "fba-plan", "brand-inventory", "oli-quality-summary", "sales-movers", "listing-health",
    "buy-box-loss", "returns-leakage", "ppc-performance", "listing-optimizer", "accounts", "fx-rates"];
  for (const a of known) assert.ok(REPORT_CAPABILITIES[a], `action '${a}' is registered`);
  for (const [a, cap] of Object.entries(REPORT_CAPABILITIES)) {
    if (isBrandAccessible(cap)) assert.ok(requiresScopeAdapter(cap), `${a} brand-accessible => needs adapter`);
  }
  // A fabricated future action falls through to a fail-closed DENY (never silently brand-accessible).
  assert.equal(REPORT_CAPABILITIES["totally-new-report"], undefined);
});

await test("23. admin is unrestricted for any report (byte-identical serving)", async () => {
  const s = await resolveUserReportScope({ access: access({ role: "admin" }), requestedAccountId: "A", requestedBrand: "ALL", action: "fba-plan", getTrustedBrands });
  assert.equal(s.restricted, false); assert.equal(s.mode, "ADMIN");
});

await test("24. an ALL_BRANDS user is unrestricted (byte-identical), even for a deny-listed report", async () => {
  const s = await resolveUserReportScope({ access: access(), requestedAccountId: "A", requestedBrand: "ALL", action: "reconciliation", getTrustedBrands });
  assert.equal(s.restricted, false); assert.equal(s.mode, "ALL_BRANDS");
});

await test("5. SELECTED_BRANDS: an account the user lacks -> 403", async () => {
  await throws403(() => resolveUserReportScope({ access: selA(["bebi born"]), requestedAccountId: "ZZZ", requestedBrand: "Bebi Born", action: "brand-sales", getTrustedBrands }));
});

await test("6/9. SELECTED_BRANDS: a named brand not permitted -> 403, never an ALL fallback", async () => {
  await throws403(() => resolveUserReportScope({ access: selA(["bebi born"]), requestedAccountId: "A", requestedBrand: "ACME Corp", action: "brand-sales", getTrustedBrands }), /requested brand/i);
});

await test("10. SELECTED_BRANDS: a permitted named brand resolves to that brand only", async () => {
  const s = await resolveUserReportScope({ access: selA(["bebi born", "acme corp"]), requestedAccountId: "A", requestedBrand: "ACME Corp", action: "brand-sales", getTrustedBrands });
  assert.equal(s.restricted, true); assert.equal(s.brandScope, "NAMED"); assert.equal(s.requestedBrandKey, "acme corp");
  assert.deepEqual([...s.permittedBrandKeys].sort(), ["acme corp", "bebi born"]);
});

await test("19. a single permitted brand auto-selects even when 'ALL' is requested", async () => {
  const s = await resolveUserReportScope({ access: selA(["acme corp"]), requestedAccountId: "A", requestedBrand: "ALL", action: "brand-sales", getTrustedBrands });
  assert.equal(s.brandScope, "NAMED"); assert.equal(s.requestedBrandKey, "acme corp");
});

await test("20. multiple permitted brands + 'All' -> ALL_PERMITTED for a derivable report (projection)", async () => {
  const s = await resolveUserReportScope({ access: selA(["acme corp", "bebi born"]), requestedAccountId: "A", requestedBrand: "All permitted brands", action: "brand-sales", getTrustedBrands });
  assert.equal(s.brandScope, "ALL_PERMITTED"); assert.deepEqual([...s.permittedBrandKeys].sort(), ["acme corp", "bebi born"]);
});

await test("A FILTERABLE report denies 'all permitted' with >1 brand (secure constraint, 409), never a leak", async () => {
  await throws403(() => resolveUserReportScope({ access: selA(["acme corp", "bebi born"]), requestedAccountId: "A", requestedBrand: "ALL", action: "daily", getTrustedBrands }), /permitted brand/i);
});

await test("A denied report is 403 for a SELECTED_BRANDS user (admin/ALL unaffected)", async () => {
  await throws403(() => resolveUserReportScope({ access: selA(["bebi born"]), requestedAccountId: "A", requestedBrand: "Bebi Born", action: "reconciliation", getTrustedBrands }), /not available/i);
});

await test("12/13. a granted key NOT in trusted membership contributes nothing (removed brand disappears)", async () => {
  // Granted 'gone brand' + 'bebi born'; membership only has bebi born/bebi-born/acme corp -> only bebi born effective.
  const s = await resolveUserReportScope({ access: selA(["bebi born", "gone brand"]), requestedAccountId: "A", requestedBrand: "ALL", action: "brand-sales", getTrustedBrands });
  assert.deepEqual([...s.permittedBrandKeys], ["bebi born"]); assert.equal(s.brandScope, "NAMED");
});

await test("13b. if ALL granted brands were removed from membership -> 403 (no permitted brands)", async () => {
  await throws403(() => resolveUserReportScope({ access: selA(["gone brand"]), requestedAccountId: "A", requestedBrand: "ALL", action: "brand-sales", getTrustedBrands }), /no permitted brands/i);
});

await test("14. punctuation-distinct brands stay distinct (Bebi Born vs Bebi-Born)", async () => {
  // Granted 'bebi born' only; requesting 'Bebi-Born' (punctuation variant, a DIFFERENT brand) -> 403.
  await throws403(() => resolveUserReportScope({ access: selA(["bebi born"]), requestedAccountId: "A", requestedBrand: "Bebi-Born", action: "brand-sales", getTrustedBrands }));
  // and requesting the exact granted one succeeds
  const s = await resolveUserReportScope({ access: selA(["bebi born"]), requestedAccountId: "A", requestedBrand: "Bebi Born", action: "brand-sales", getTrustedBrands });
  assert.equal(s.requestedBrandKey, "bebi born");
});

await test("15. case/whitespace variants resolve to the same canonical key", async () => {
  const s = await resolveUserReportScope({ access: selA(["acme corp"]), requestedAccountId: "A", requestedBrand: "  acme   CORP ", action: "brand-sales", getTrustedBrands });
  assert.equal(s.requestedBrandKey, "acme corp");
});

await test("7. a forged role/org/brand in the request is ignored (authority is the token access only)", async () => {
  // The resolver only reads access.role + access.accountGrants; requestedBrand is validated, never trusted as authority.
  // A viewer cannot become admin by any request field -> still enforced.
  await throws403(() => resolveUserReportScope({ access: selA(["bebi born"]), requestedAccountId: "A", requestedBrand: "ACME Corp", action: "brand-sales", getTrustedBrands }));
});

await test("45. the access fingerprint changes on every permission mutation", () => {
  const base = accessFingerprint(selA(["bebi born"]));
  assert.notEqual(base, accessFingerprint(selA(["bebi born", "acme corp"])), "adding a brand changes it");
  assert.notEqual(base, accessFingerprint(access()), "mode change changes it");
  assert.notEqual(base, accessFingerprint(access({ role: "admin", accountGrants: selA(["bebi born"]).accountGrants })), "role change changes it");
  assert.equal(base, accessFingerprint(selA(["bebi born"])), "same grants -> same fingerprint (stable)");
});

await test("30. projection: Dashboard payload keeps ONLY permitted-brand rows + catalogBrands + asinBrand", () => {
  const payload = {
    rows: [{ product_brand: "Bebi Born", sales: 10 }, { product_brand: "ACME Corp", sales: 5 }, { product_brand: "Unassigned", sales: 3 }],
    catalogBrands: ["Bebi Born", "ACME Corp", "Unassigned"], asinBrand: { B01: "Bebi Born", B02: "ACME Corp" },
  };
  const projected = projectBrandSalesPayload(payload, new Set(["bebi born"]));
  assert.deepEqual(projected.rows, [{ product_brand: "Bebi Born", sales: 10 }]);
  assert.deepEqual(projected.catalogBrands, ["Bebi Born"]);
  assert.deepEqual(projected.asinBrand, { B01: "Bebi Born" });
  assert.equal(projected.brandScoped, true);
});

await test("27. projection: SKU Movement keeps only permitted-brand ASIN rows", () => {
  const payload = { rows: [{ asin: "B01", brand: "Bebi Born" }, { asin: "B02", brand: "ACME Corp" }, { asin: "B03", brand: "Unmapped" }], catalogBrands: ["Bebi Born", "ACME Corp"] };
  const projected = projectSkuMovementPayload(payload, new Set(["acme corp"]));
  assert.deepEqual(projected.rows.map((r) => r.asin), ["B02"]);
  assert.deepEqual(projected.catalogBrands, ["ACME Corp"]);
});

await test("35. projection: brand directory keeps only permitted brands + intersects account lists to authorized pairs", () => {
  const payload = { brands: ["Bebi Born", "Zeta"], brandKeys: ["bebi born", "zeta"], brandAccounts: { "bebi born": ["A", "B"], zeta: ["B"] }, brandDisplay: { "bebi born": "Bebi Born", zeta: "Zeta" } };
  const pairs = new Map([["bebi born", new Set(["A"])]]); // user may see Bebi Born only in A
  const projected = projectBrandDirectoryPayload(payload, new Set(["bebi born"]), pairs);
  assert.deepEqual(projected.brandKeys, ["bebi born"]);
  assert.deepEqual(projected.brandAccounts, { "bebi born": ["A"] }, "account B dropped for Bebi Born (not an authorized pair)");
  assert.ok(!projected.brands.includes("Zeta"), "Zeta hidden entirely");
});

await test("36/37. Brand View pair: a SELECTED_BRANDS account contributes a brand ONLY if granted AND trusted", () => {
  const trusted = new Set(["bebi born", "acme corp"]);
  // Account A: user granted Bebi Born only.
  const grantA = { mode: "SELECTED_BRANDS", brandKeys: ["bebi born"] };
  assert.equal(accountBrandPairAuthorized({ grant: grantA, requestedBrandKey: "Bebi Born", trustedKeys: trusted }), true, "granted + trusted -> contributes");
  assert.equal(accountBrandPairAuthorized({ grant: grantA, requestedBrandKey: "ACME Corp", trustedKeys: trusted }), false, "same account, ungranted brand -> excluded (test 36: not another account's brand)");
  // A granted brand that is NOT in trusted membership (removed) -> excluded.
  assert.equal(accountBrandPairAuthorized({ grant: { mode: "SELECTED_BRANDS", brandKeys: ["gone"] }, requestedBrandKey: "gone", trustedKeys: trusted }), false, "granted but not trusted -> excluded");
});

await test("39. an ALL_BRANDS account contributes any brand; a non-granted account never contributes; admin always", () => {
  assert.equal(accountBrandPairAuthorized({ grant: { mode: "ALL_BRANDS", brandKeys: null }, requestedBrandKey: "Anything", trustedKeys: new Set(["anything"]) }), true, "ALL_BRANDS -> contributes");
  assert.equal(accountBrandPairAuthorized({ grant: null, requestedBrandKey: "Bebi Born", trustedKeys: new Set(["bebi born"]) }), false, "no grant for this account -> never contributes");
  assert.equal(accountBrandPairAuthorized({ isAdmin: true, grant: null, requestedBrandKey: "X", trustedKeys: new Set() }), true, "admin -> always");
});

await test("30b. filterRowsToBrands never lets an Unmapped/blank-brand row into a named scope", () => {
  const rows = [{ brand: "Bebi Born" }, { brand: "" }, { brand: "Unmapped" }, {}];
  assert.deepEqual(filterRowsToBrands(rows, new Set(["bebi born"])), [{ brand: "Bebi Born" }]);
});

await test("40. resolveAuthorizedBrandMap: non-admin ALL_BRANDS account -> the account's TRUSTED brands (never org-wide)", async () => {
  // user has A (ALL_BRANDS) + B (ALL_BRANDS). A sells bebi born/bebi-born/acme corp; B sells zeta.
  const map = await resolveAuthorizedBrandMap({ access: access(), getTrustedBrands });
  assert.equal(map.admin, false);
  assert.deepEqual(map.accounts.A.permittedKeys, ["acme corp", "bebi born", "bebi-born"], "A -> A's trusted brands only");
  assert.deepEqual(map.accounts.B.permittedKeys, ["zeta"], "B -> B's trusted brands only");
  // A brand that exists ONLY in an unauthorized account (not A or B) never appears in either account's permitted set.
  assert.ok(!map.accounts.A.permittedKeys.includes("zeta"), "A does not get B's brand (per-account pairs)");
  assert.ok(!map.accounts.B.permittedKeys.includes("bebi born"), "B does not get A's brand");
});

await test("41. resolveAuthorizedBrandMap: SELECTED_BRANDS -> trusted INTERSECT granted; admin -> {admin:true}", async () => {
  const selAonly = { userId: "u1", role: "viewer", accountIds: ["A"], accountGrants: { A: { mode: "SELECTED_BRANDS", brandKeys: ["bebi born", "gone brand"] } } };
  const map = await resolveAuthorizedBrandMap({ access: selAonly, getTrustedBrands });
  assert.deepEqual(map.accounts.A.permittedKeys, ["bebi born"], "granted 'gone brand' is not trusted -> excluded");
  const adminMap = await resolveAuthorizedBrandMap({ access: { role: "admin", accountIds: ["A"], accountGrants: {} }, getTrustedBrands });
  assert.equal(adminMap.admin, true, "admin -> unrestricted org-wide (no per-account map applied)");
});

await test("42. resolveAuthorizedBrandMap: a trusted-membership READ FAILURE is fail-soft (resolved:false, empty keys)", async () => {
  const failReader = async ({ accountId }) => { if (accountId === "A") throw new Error("db"); return TRUSTED[accountId] || []; };
  const map = await resolveAuthorizedBrandMap({ access: access(), getTrustedBrands: failReader });
  assert.equal(map.accounts.A.resolved, false, "A read failed -> resolved:false (caller leaves it unrestricted, never hides all)");
  assert.deepEqual(map.accounts.A.permittedKeys, []);
  assert.equal(map.accounts.B.resolved, true, "B still resolves");
  assert.deepEqual(map.accounts.B.permittedKeys, ["zeta"]);
});

out("\n" + passed + " assertions passed");
