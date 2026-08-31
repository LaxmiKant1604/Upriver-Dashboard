// CENTRAL account + brand authorization resolver + report capability registry (the ONE place brand-scope decisions
// are made). Pure + dependency-light so it is fully offline-testable: the trusted-membership reader is INJECTED.
//
// SAFETY MODEL: enforcement changes behaviour ONLY for a SELECTED_BRANDS user. An admin and an ALL_BRANDS user get
// `restricted:false` -> every serving path is byte-identical to before. After migration every existing grant is
// ALL_BRANDS, so production output is byte-identical for 100% of current users until an admin narrows someone.
//
// The requested organization/brand/role/account are NEVER trusted from the browser: the resolver reads the
// authenticated user's grants (from getDashboardAccess) and the account's TRUSTED membership (brand-sales evidence).

import { createHash } from "node:crypto";
import { brandKey } from "./reports/brand-membership.js";

// ---- Phase 5: report capability registry --------------------------------------------------------------------
// Every report ACTION (api/datadoe.js dispatch identity) MUST appear here. A route missing from the registry fails
// closed (treated as DENY for a brand-restricted user, and the registry-coverage test fails).
export const CAPABILITY = Object.freeze({
  // A single named brand is served securely by the existing server derive/scope; "all permitted" (>1) is served by
  // projecting the canonical payload's rows to the permitted key set (rows carry an attributable brand).
  BRAND_FILTERABLE: "BRAND_FILTERABLE",
  // Rows carry an ASIN/SKU-attributable brand; a server-side projection filters rows to the permitted brand keys.
  BRAND_DERIVABLE_FROM_ASIN_SKU: "BRAND_DERIVABLE_FROM_ASIN_SKU",
  // Account-wide, no reviewed brand filter yet -> a SELECTED_BRANDS user is DENIED (403). ADMIN reads unaffected.
  DENY_FOR_BRAND_RESTRICTED_USERS: "DENY_FOR_BRAND_RESTRICTED_USERS",
  // Not a brand-scoped report (own-account/own-user utility, self-filtered directory, admin diagnostics). No brand
  // decision; a SELECTED_BRANDS user is neither projected nor denied on brand grounds.
  NON_REPORT: "NON_REPORT",
});

export const REPORT_CAPABILITIES = Object.freeze({
  // Brand-projectable report payloads (rows carry brand; totals are client-computed from rows).
  "brand-sales": CAPABILITY.BRAND_DERIVABLE_FROM_ASIN_SKU,      // Dashboard
  "sku-movement": CAPABILITY.BRAND_DERIVABLE_FROM_ASIN_SKU,     // per-ASIN rows
  // Server derives/serves a single named brand securely (and the brand list can be filtered to permitted).
  "daily": CAPABILITY.BRAND_FILTERABLE,
  "brand-view": CAPABILITY.BRAND_FILTERABLE,
  "brand-view-portfolio": CAPABILITY.BRAND_FILTERABLE,
  "brand-portfolio": CAPABILITY.BRAND_FILTERABLE,
  "brand-view-brands": CAPABILITY.BRAND_FILTERABLE,
  "brand-directory": CAPABILITY.BRAND_FILTERABLE,
  "oli-quality": CAPABILITY.BRAND_FILTERABLE,
  // Account-wide reports with no reviewed brand filter -> denied for a brand-restricted user.
  "sales": CAPABILITY.DENY_FOR_BRAND_RESTRICTED_USERS,
  "reconciliation": CAPABILITY.DENY_FOR_BRAND_RESTRICTED_USERS,
  "sku-pl": CAPABILITY.DENY_FOR_BRAND_RESTRICTED_USERS,
  "keyword-rank": CAPABILITY.DENY_FOR_BRAND_RESTRICTED_USERS,
  "content-changes": CAPABILITY.DENY_FOR_BRAND_RESTRICTED_USERS,
  "fba-plan": CAPABILITY.DENY_FOR_BRAND_RESTRICTED_USERS,
  "brand-inventory": CAPABILITY.DENY_FOR_BRAND_RESTRICTED_USERS,
  "oli-quality-summary": CAPABILITY.DENY_FOR_BRAND_RESTRICTED_USERS,
  "sales-movers": CAPABILITY.DENY_FOR_BRAND_RESTRICTED_USERS,
  "listing-health": CAPABILITY.DENY_FOR_BRAND_RESTRICTED_USERS,
  "buy-box-loss": CAPABILITY.DENY_FOR_BRAND_RESTRICTED_USERS,
  "returns-leakage": CAPABILITY.DENY_FOR_BRAND_RESTRICTED_USERS,
  "ppc-performance": CAPABILITY.DENY_FOR_BRAND_RESTRICTED_USERS,
  "listing-optimizer": CAPABILITY.DENY_FOR_BRAND_RESTRICTED_USERS,
  // Not brand-scoped (self-filtered / own-scope / admin diagnostics).
  "accounts": CAPABILITY.NON_REPORT,
  "fx-rates": CAPABILITY.NON_REPORT,
  "fields": CAPABILITY.NON_REPORT,   // admin-only, gated elsewhere
  "sample": CAPABILITY.NON_REPORT,   // admin-only, gated elsewhere
});

// A report whose capability lets a SELECTED_BRANDS user see it at all (projected or single-named-brand). Everything
// else is denied for such a user. NON_REPORT is out of scope for brand enforcement.
export function isBrandAccessible(capability) {
  return capability === CAPABILITY.BRAND_FILTERABLE || capability === CAPABILITY.BRAND_DERIVABLE_FROM_ASIN_SKU;
}

// Every registered brand-accessible report MUST have a server-side scope adapter available (projection for
// DERIVABLE, or a server named-brand derive for FILTERABLE). The registry-coverage test asserts this mapping so a
// future brand-accessible report cannot ship without an adapter.
export function requiresScopeAdapter(capability) {
  return isBrandAccessible(capability);
}

const ALL_TOKENS = new Set(["", "all", "all brands", "all permitted", "all permitted brands"]);
function isAllRequest(brand) {
  return ALL_TOKENS.has(String(brand == null ? "" : brand).trim().toLowerCase());
}

export class BrandAccessError extends Error {
  constructor(message, status = 403) { super(message); this.name = "BrandAccessError"; this.status = status; }
}

// A stable ACCESS/VERSION fingerprint over the user's identity + role + every account grant (mode + sorted brand
// keys). It changes whenever account access, a mode, or a selected-brand set changes, or the role changes -- so a
// per-user cache keyed by it is invalidated the instant permissions mutate. Never contains a secret.
export function accessFingerprint(access) {
  const grants = access && access.accountGrants ? access.accountGrants : {};
  const parts = Object.keys(grants).sort().map((acct) => {
    const g = grants[acct] || {};
    const keys = Array.isArray(g.brandKeys) ? [...g.brandKeys].sort() : [];
    return `${acct}:${g.mode || "ALL_BRANDS"}:${keys.join("|")}`;
  });
  const canonical = JSON.stringify({ u: access?.userId || "", r: access?.role || "", g: parts });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

/**
 * Resolve the trusted report scope for ONE report request. Throws BrandAccessError (403) for any unauthorized
 * account/brand or a denied report, WITHOUT revealing whether an inaccessible account/brand exists.
 *
 * @param {object}   access             from getDashboardAccess (authenticated; the ONLY authority)
 * @param {string}   requestedAccountId the account the request targets (already account-authorized by the caller)
 * @param {string}   requestedBrand     the browser's brand param (validated here; never trusted as authority)
 * @param {string}   action             the report action (registry key)
 * @param {function} getTrustedBrands   async ({accountId}) -> [{key, display}] trusted membership (injected)
 * @returns {Promise<object>} scope
 */
export async function resolveUserReportScope({ access, requestedAccountId, requestedBrand, action, getTrustedBrands }) {
  const capability = REPORT_CAPABILITIES[action] || CAPABILITY.DENY_FOR_BRAND_RESTRICTED_USERS; // fail closed
  const accountId = String(requestedAccountId || "").trim();
  const fingerprint = accessFingerprint(access);

  // Admin: full trusted access, no brand restriction, byte-identical serving.
  if (access && access.role === "admin") {
    return { restricted: false, mode: "ADMIN", capability, brandScope: "ALL", permittedBrandKeys: null, requestedBrandKey: null, fingerprint, accountId };
  }

  // The account must be granted (defence in depth; the caller also runs assertAccountAccess). A missing grant is a
  // 403 that never says whether the account exists.
  const grant = access && access.accountGrants ? access.accountGrants[accountId] : null;
  const hasAccount = grant != null || (Array.isArray(access?.accountIds) && access.accountIds.includes(accountId));
  if (accountId && !hasAccount) throw new BrandAccessError("You do not have access to the selected account.", 403);

  const mode = grant && grant.mode === "SELECTED_BRANDS" ? "SELECTED_BRANDS" : "ALL_BRANDS";

  // ALL_BRANDS (or an account with no explicit grant row but present in accountIds): unrestricted, byte-identical.
  if (mode === "ALL_BRANDS") {
    return { restricted: false, mode: "ALL_BRANDS", capability, brandScope: "ALL", permittedBrandKeys: null, requestedBrandKey: null, fingerprint, accountId };
  }

  // SELECTED_BRANDS from here on.
  if (!isBrandAccessible(capability)) {
    throw new BrandAccessError("This report is not available for your brand-limited access.", 403);
  }

  // Effective permitted brands = the granted keys INTERSECTED with the account's CURRENT trusted membership, so a
  // brand removed from the account (or a stale grant key) contributes nothing.
  const granted = new Set((grant.brandKeys || []).map((k) => brandKey(k)).filter(Boolean));
  const trusted = await getTrustedBrands({ accountId });
  const trustedByKey = new Map();
  for (const b of Array.isArray(trusted) ? trusted : []) { if (b && b.key) trustedByKey.set(b.key, b.display || b.key); }
  const permittedKeys = [...granted].filter((k) => trustedByKey.has(k)).sort();
  const permittedBrandKeys = new Set(permittedKeys);
  const permittedBrandDisplays = permittedKeys.map((k) => trustedByKey.get(k));

  if (permittedBrandKeys.size === 0) {
    throw new BrandAccessError("You have no permitted brands for this account.", 403);
  }

  // Resolve the requested brand against the permitted set.
  let brandScope;
  let requestedBrandKey = null;
  if (isAllRequest(requestedBrand)) {
    if (permittedBrandKeys.size === 1) { brandScope = "NAMED"; requestedBrandKey = permittedKeys[0]; }  // single -> auto-select
    else brandScope = "ALL_PERMITTED";
  } else {
    const rk = brandKey(requestedBrand);
    if (!rk || !permittedBrandKeys.has(rk)) {
      // A named request for a brand not permitted is a 403 -- never an ALL fallback, never revealing the brand.
      throw new BrandAccessError("You do not have access to the requested brand.", 403);
    }
    brandScope = "NAMED";
    requestedBrandKey = rk;
  }

  // A FILTERABLE report cannot serve ALL_PERMITTED (its ALL payload is account-wide, no per-row brand) when more than
  // one brand is permitted: require a specific permitted brand (a deliberate, secure constraint -- never a leak).
  if (brandScope === "ALL_PERMITTED" && capability === CAPABILITY.BRAND_FILTERABLE && action !== "brand-directory" && action !== "brand-view-brands") {
    throw new BrandAccessError("Select one of your permitted brands to view this report.", 409);
  }

  return {
    restricted: true, mode: "SELECTED_BRANDS", capability,
    brandScope, requestedBrandKey,
    permittedBrandKeys, permittedBrandDisplays: new Map(permittedKeys.map((k) => [k, trustedByKey.get(k)])),
    fingerprint, accountId,
  };
}

// ---- projection helpers (Phase 6): filter an already-built canonical payload to the permitted brand keys ----------
// A payload row's brand key, from any of the common brand fields.
export function rowBrandKey(row) {
  if (!row) return null;
  return brandKey(row.product_brand ?? row.brand ?? row.brandName ?? row.productBrand ?? "");
}

// Filter a set of rows to those whose brand key is permitted (or exactly the one named key).
export function filterRowsToBrands(rows, permittedKeys) {
  const allow = permittedKeys instanceof Set ? permittedKeys : new Set(permittedKeys || []);
  return (Array.isArray(rows) ? rows : []).filter((r) => { const k = rowBrandKey(r); return k && allow.has(k); });
}

// Project a Dashboard (brand-sales) payload to the permitted brand keys: filter rows + catalogBrands + asinBrand map.
// Totals are computed CLIENT-side from rows, so returning only permitted rows yields correct totals with NO formula
// change. `keySet` is a Set of permitted canonical brand keys (or a single-element set for a named brand).
export function projectBrandSalesPayload(payload, keySet) {
  if (!payload || typeof payload !== "object") return payload;
  const allow = keySet instanceof Set ? keySet : new Set(keySet || []);
  const rows = filterRowsToBrands(payload.rows, allow);
  const catalogBrands = (Array.isArray(payload.catalogBrands) ? payload.catalogBrands : []).filter((b) => allow.has(brandKey(b)));
  const asinBrand = {};
  for (const [asin, brand] of Object.entries(payload.asinBrand || {})) { if (allow.has(brandKey(brand))) asinBrand[asin] = brand; }
  return { ...payload, rows, catalogBrands, asinBrand, brandScoped: true };
}

// Project a SKU Movement payload to permitted brand keys: filter rows (each row carries `brand`). KPIs are
// client-computed from rows, so this yields correct totals. catalogBrands/brand list trimmed too.
export function projectSkuMovementPayload(payload, keySet) {
  if (!payload || typeof payload !== "object") return payload;
  const allow = keySet instanceof Set ? keySet : new Set(keySet || []);
  const rows = (Array.isArray(payload.rows) ? payload.rows : []).filter((r) => allow.has(brandKey(r && r.brand)));
  const catalogBrands = (Array.isArray(payload.catalogBrands) ? payload.catalogBrands : []).filter((b) => allow.has(brandKey(b)));
  return { ...payload, rows, catalogBrands, brandScoped: true };
}

// Filter a brand DIRECTORY payload ({ brands, brandKeys, brandAccounts, brandDisplay }) to the permitted keys so a
// brand-restricted user's selector never reveals brand names they may not access. Also intersects each brand's
// account list with the accounts the user may access for THAT brand (pairsByBrandKey: Map<key, Set<accountId>>).
export function projectBrandDirectoryPayload(payload, permittedKeys, pairsByBrandKey = null) {
  if (!payload || typeof payload !== "object") return payload;
  const allow = permittedKeys instanceof Set ? permittedKeys : new Set(permittedKeys || []);
  const brandKeysOut = (Array.isArray(payload.brandKeys) ? payload.brandKeys : []).filter((k) => allow.has(k));
  const brandAccounts = {};
  const brandDisplay = {};
  const brands = [];
  for (const k of brandKeysOut) {
    const accts = (payload.brandAccounts && payload.brandAccounts[k]) || [];
    const pair = pairsByBrandKey instanceof Map ? pairsByBrandKey.get(k) : null;
    brandAccounts[k] = pair ? accts.filter((a) => pair.has(String(a))) : accts;
    brandDisplay[k] = (payload.brandDisplay && payload.brandDisplay[k]) || k;
    brands.push(brandDisplay[k]);
  }
  return { ...payload, brands, brandKeys: brandKeysOut, brandAccounts, brandDisplay, brandScoped: true };
}
