// Paid-build + shared-directory write gate (api/datadoe.js) -- a non-admin can never spend DataDoe tokens or overwrite
// the shared account directory. Fully offline, over the REAL handler with an emulated Supabase (global fetch stub) and a
// REFUSING DataDoe host (every DataDoe request is recorded and refused):
//   P  every paid refresh=1 (the manual-paid insight/legacy builders, the dormant sales / brand-portfolio builders, the
//      admin diagnostics, the brand-directory Catalog sync, and any FUTURE non-route-owned action) by a signed-in
//      NON-ADMIN with full access to the account -> 403, ZERO DataDoe requests, ZERO writes (no lock claim, no save)
//   D  a non-admin refresh=1 of the account list is answered from the SAVED directory: 200 + the saved accounts +
//      refreshReadOnly:true, ZERO DataDoe, ZERO writes; a plain read is unchanged
//   A  admins are unchanged: a paid refresh still claims its lock and reaches its DataDoe builder; the account-list
//      refresh still reaches DataDoe
//   U  unchanged neighbours: unauthenticated -> 401 and a member without the account -> 403, both with zero DataDoe; a
//      route-owned refresh=1 stays the read-only 200; a member's plain paid-report read stays a zero-write 200
//   S  structural: the gate precedes every refreshable builder call in handleDataDoe, so a future paid builder added
//      below it is covered automatically
// 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; out("  ok  " + name); };
out("paid-refresh-authz");

// ---- env BEFORE any server module loads (module-level consts capture it) --------------------------------------------
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = ["test", "svc", "role", "key"].join("-");
process.env.DATADOE_API_KEY = ["test", "datadoe", "key"].join("-");
delete process.env.DATADOE_API_KEY_SECONDARY;
delete process.env.LHV3_PUBLISH_LIVE;
delete process.env.LISTING_HEALTH_V3;

const ACC = "ACCTIN0001";
const AS_OF = "2026-09-25";
const net = { writes: [], datadoe: [] };
const SAVED_ACCOUNTS = [{ id: ACC, name: "Acct IN", country: "IN", currency: "INR", active: true }];
const row = (reportKey, payload, params = {}) => ({
  id: "row-" + reportKey, report_key: reportKey, account_id: ACC, params_hash: "seeded", params: { ...params },
  payload, payload_bytes: 100, payload_storage_path: null,
  source_refreshed_at: "2026-09-25T01:00:00.000Z", updated_at: "2026-09-25T01:00:01.000Z", created_at: "2026-09-25T01:00:01.000Z",
});
const SEED = {
  "account-directory": row("account-directory", { accounts: SAVED_ACCOUNTS }, { reportVersion: "account-directory-shared-v1" }),
  "sales-movers": row("sales-movers", { rows: [], accountId: ACC }, { to: AS_OF }),
  "returns-leakage": row("returns-leakage", { rows: [], window: { days: 90 } }, { reportVersion: "returns-leakage-v3", to: AS_OF }),
};
// Production roles are admin / editor / viewer (20260728_shared_dashboard.sql). tok-member is an EDITOR with FULL
// (ALL_BRANDS) access to the account -- the strongest non-admin grant; tok-sel is an EDITOR limited to one brand
// (SELECTED_BRANDS); tok-noacc is a VIEWER with no grant at all.
const USERS = { "tok-admin": "u-admin", "tok-member": "u-member", "tok-noacc": "u-noacc", "tok-sel": "u-sel" };
const ROLES = { "u-admin": "admin", "u-member": "editor", "u-noacc": "viewer", "u-sel": "editor" };
const GRANTS = { "u-member": [{ account_id: ACC, brand_scope_mode: "ALL_BRANDS" }], "u-sel": [{ account_id: ACC, brand_scope_mode: "SELECTED_BRANDS" }] };
// A STABLE read-only SQL function PostgREST exposes as a POST RPC (20260911: language sql STABLE) is a READ, not a write
// (the same allow-list as scripts/refresh-readonly.test.js).
const READ_ONLY_RPCS = new Set(["/rest/v1/rpc/resolve_oli_sku_asin"]);
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = String(opts.method || "GET").toUpperCase();
  if (!u.startsWith("http://supabase.test")) { net.datadoe.push(method + " " + u); throw new Error("DATADOE_CALL_REFUSED_BY_TEST"); }
  const p = u.slice("http://supabase.test".length);
  if (p.startsWith("/auth/v1/user")) {
    const tok = String((opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || "").replace(/^Bearer /, "");
    return USERS[tok] ? jsonRes(200, { id: USERS[tok], email: USERS[tok] + "@x" }) : jsonRes(401, { msg: "no" });
  }
  if (method === "POST" && READ_ONLY_RPCS.has(p.split("?")[0])) return jsonRes(200, []);
  if (method !== "GET") {
    net.writes.push(method + " " + p.split("?")[0]);
    if (p.startsWith("/rest/v1/rpc/claim_report_refresh_lock")) return jsonRes(200, true);
    return jsonRes(200, []);
  }
  const q = new URLSearchParams(p.split("?")[1] || "");
  const uid = String(q.get("user_id") || "").replace(/^eq\./, "");
  if (p.startsWith("/rest/v1/user_profiles")) return jsonRes(200, [{ role: ROLES[uid] || "viewer", display_name: "t" }]);
  if (p.startsWith("/rest/v1/account_permissions")) return jsonRes(200, GRANTS[uid] || []);
  if (p.startsWith("/rest/v1/account_brand_grant")) return jsonRes(200, uid === "u-sel" ? [{ account_id: ACC, canonical_brand_key: "acme" }] : []);
  if (p.startsWith("/rest/v1/report_snapshots")) {
    const k = (q.get("report_key") || "").replace(/^eq\./, "");
    return jsonRes(200, SEED[k] ? [SEED[k]] : []);
  }
  return jsonRes(200, []);
};
const fakeRes = () => ({ statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} });

const DD = await import("../api/datadoe.js");
async function call(query, token) {
  const res = fakeRes();
  const before = { d: net.datadoe.length, w: net.writes.length };
  await DD.default({ method: "GET", query: { ...query }, headers: { authorization: "Bearer " + token } }, res);
  return { status: res.statusCode, body: res.body || {}, datadoe: net.datadoe.slice(before.d), writes: net.writes.slice(before.w) };
}

// Every refresh=1 that can reach a paid DataDoe build today (and one future action standing in for any builder added later).
const PAID = {
  "sales-movers": { action: "sales-movers", ids: ACC, to: AS_OF },
  "listing-health": { action: "listing-health", ids: ACC, to: AS_OF },
  "buy-box-loss": { action: "buy-box-loss", ids: ACC, to: AS_OF },
  "ppc-performance": { action: "ppc-performance", ids: ACC, to: AS_OF },
  "listing-optimizer": { action: "listing-optimizer", ids: ACC, to: AS_OF },
  "reconciliation": { action: "reconciliation", ids: ACC, from: "2026-03-01", to: AS_OF },
  "sku-pl": { action: "sku-pl", ids: ACC, from: "2026-03-01", to: AS_OF },
  "keyword-rank": { action: "keyword-rank", ids: ACC, to: AS_OF },
  "content-changes": { action: "content-changes", ids: ACC, asOf: AS_OF },
  "sales": { action: "sales", ids: ACC, from: "2026-09-01", to: AS_OF },
  "brand-portfolio": { action: "brand-portfolio", ids: ACC, brand: "Acme", asOf: AS_OF },
  "brand-directory (Catalog sync)": { action: "brand-directory", ids: ACC, catalogSyncActionId: "act-test-0001" },
  "fields (admin diagnostics)": { action: "fields", sourceId: "x" },
  "sample (admin diagnostics)": { action: "sample", ids: ACC, sourceId: "x" },
  "a FUTURE non-route-owned action": { action: "some-future-paid-report", ids: ACC, to: AS_OF },
};

// =====================================================================================================================
// P. a non-admin can never reach a paid build
// =====================================================================================================================
for (const [name, q] of Object.entries(PAID)) {
  const r = await call({ ...q, refresh: "1" }, "tok-member");
  ok(`P ${name}: a full-access NON-ADMIN refresh=1 -> 403 with ZERO DataDoe requests and ZERO writes (no lock, no save)`,
    r.status === 403 && r.datadoe.length === 0 && r.writes.length === 0);
}
{
  const r = await call({ ...PAID["sales-movers"], refresh: "1" }, "tok-member");
  ok("P the gate's refusal is typed (code ADMIN_REQUIRED_FOR_DATADOE_REFRESH) and tells the user Reload shows the saved copy",
    r.body.code === "ADMIN_REQUIRED_FOR_DATADOE_REFRESH" && /admin/i.test(r.body.error) && /saved copy/.test(r.body.error));
  const t = await call({ ...PAID["reconciliation"], refresh: "true" }, "tok-member");
  ok("P every accepted spelling of refresh (refresh=true) is gated too", t.status === 403 && t.datadoe.length === 0 && t.writes.length === 0);
}

// =====================================================================================================================
// D. the shared account directory: a non-admin refresh is a READ of the saved directory
// =====================================================================================================================
{
  const r = await call({ action: "accounts", refresh: "1" }, "tok-member");
  ok("D a NON-ADMIN refresh=1 of the account list -> 200 with the SAVED accounts, ZERO DataDoe, ZERO writes (the shared directory is never overwritten)",
    r.status === 200 && JSON.stringify(r.body.accounts) === JSON.stringify(SAVED_ACCOUNTS) && r.datadoe.length === 0 && r.writes.length === 0);
  ok("D ... and the answer says it was read-only (refreshReadOnly:true)", r.body.refreshReadOnly === true);
  const none = await call({ action: "accounts", refresh: "1" }, "tok-noacc");
  ok("D a signed-in user with ZERO account grants cannot overwrite the directory either: 200, no accounts shown, ZERO DataDoe, ZERO writes",
    none.status === 200 && Array.isArray(none.body.accounts) && none.body.accounts.length === 0 && none.datadoe.length === 0 && none.writes.length === 0);
  const read = await call({ action: "accounts" }, "tok-member");
  ok("D a plain account-list read is unchanged: 200, the saved accounts, no refreshReadOnly notice, zero DataDoe / writes",
    read.status === 200 && JSON.stringify(read.body.accounts) === JSON.stringify(SAVED_ACCOUNTS) && !("refreshReadOnly" in read.body) && read.datadoe.length === 0 && read.writes.length === 0);
}

// =====================================================================================================================
// A. admins are unchanged
// =====================================================================================================================
{
  const r = await call({ ...PAID["sales-movers"], refresh: "1" }, "tok-admin");
  ok("A an ADMIN paid refresh is unchanged: it claims the refresh lock and enters its paid builder (continuation marker / DataDoe)",
    r.writes.some((w) => /rpc\/claim_report_refresh_lock/.test(w)) && (r.datadoe.length >= 1 || r.writes.includes("POST /rest/v1/report_snapshots")) && r.status !== 403);
  const a = await call({ action: "accounts", refresh: "1" }, "tok-admin");
  ok("A an ADMIN account-list refresh still asks DataDoe for the directory (never answered read-only)", a.datadoe.length >= 1 && a.body.refreshReadOnly !== true);
}

// =====================================================================================================================
// U. unchanged neighbours
// =====================================================================================================================
{
  const anon = await call({ ...PAID["sales-movers"], refresh: "1" }, "tok-nobody");
  ok("U an unauthenticated paid refresh -> 401, zero DataDoe, zero writes", anon.status === 401 && anon.datadoe.length === 0 && anon.writes.length === 0);
  const noacc = await call({ ...PAID["sales-movers"], refresh: "1" }, "tok-noacc");
  ok("U a signed-in user WITHOUT the account -> 403, zero DataDoe, zero writes", noacc.status === 403 && noacc.datadoe.length === 0 && noacc.writes.length === 0);
  const ro = await call({ action: "returns-leakage", ids: ACC, to: AS_OF, refresh: "1" }, "tok-member");
  ok("U a route-owned refresh=1 by a member stays the read-only 200 (refreshReadOnly:true, zero DataDoe, zero writes)",
    ro.status === 200 && ro.body.refreshReadOnly === true && ro.datadoe.length === 0 && ro.writes.length === 0);
  const read = await call({ ...PAID["sales-movers"] }, "tok-member");
  ok("U a member's plain read of a paid report is unchanged: 200 from the saved copy, zero DataDoe, zero writes",
    read.status === 200 && read.datadoe.length === 0 && read.writes.length === 0);
}

// =====================================================================================================================
// X. the export boundary itself: with the durable continuation protocol OFF, a paid build goes straight to
//    POST /exports -- an admin reaches it (proving the harness can see a spend), a member never does
// =====================================================================================================================
{
  const MSC = await import("../lib/server/manual-source-continuation.js");
  MSC.__setManualSourceContinuationTestOverrides({ enabled: false });
  try {
    const isExportCreate = (d) => /^POST .*\/exports(\?|$)/.test(d);
    const admin = await call({ action: "sales", ids: ACC, from: "2026-09-01", to: AS_OF, refresh: "1" }, "tok-admin");
    ok("X an ADMIN paid refresh reaches the DataDoe export-create POST (the boundary this suite guards is observable)",
      admin.datadoe.some(isExportCreate));
    for (const name of ["sales", "reconciliation", "sales-movers"]) {
      const m = await call({ ...PAID[name], refresh: "1" }, "tok-member");
      ok(`X ${name}: a NON-ADMIN refresh never reaches the export-create POST (zero DataDoe requests of any kind)`,
        m.status === 403 && m.datadoe.length === 0 && !m.datadoe.some(isExportCreate));
    }
  } finally {
    MSC.__setManualSourceContinuationTestOverrides(null);
  }
}

// =====================================================================================================================
// W. an ids value that names NO account (whitespace) -- the path the review found: it skipped the account check and
//    fell through to the legacy paid builders on a PLAIN read. Every caller, with and without refresh, with the
//    continuation protocol ON (production default: its marker write would precede the export) and OFF (the builder
//    would go straight to POST /exports): 4xx, ZERO DataDoe requests, ZERO writes.
// =====================================================================================================================
{
  const MSC = await import("../lib/server/manual-source-continuation.js");
  const BLANK = {
    "sales": { action: "sales", ids: " , ", from: "2026-09-01", to: AS_OF },
    "reconciliation": { action: "reconciliation", ids: " ", from: "2026-03-01", to: "2026-08-31" },
    "sku-pl": { action: "sku-pl", ids: " ", from: "2026-03-01", to: "2026-08-31" },
    "keyword-rank": { action: "keyword-rank", ids: " ", to: AS_OF },
    "content-changes": { action: "content-changes", ids: " ", asOf: AS_OF },
    "sales-movers": { action: "sales-movers", ids: " ", to: AS_OF },
  };
  for (const continuation of ["on", "off"]) {
    MSC.__setManualSourceContinuationTestOverrides(continuation === "off" ? { enabled: false } : null);
    try {
      for (const who of ["tok-noacc", "tok-member", "tok-sel", "tok-admin"]) {
        for (const refresh of [false, true]) {
          const results = [];
          for (const q of Object.values(BLANK)) results.push(await call({ ...q, ...(refresh ? { refresh: "1" } : {}) }, who));
          ok(`W blank ids (${who}, ${refresh ? "refresh=1" : "plain read"}, continuation ${continuation}): every legacy paid action -> 4xx with ZERO DataDoe requests and ZERO writes`,
            results.every((r) => r.status >= 400 && r.status < 500 && r.datadoe.length === 0 && r.writes.length === 0));
        }
      }
    } finally {
      MSC.__setManualSourceContinuationTestOverrides(null);
    }
  }
  const noIds = await call({ action: "reconciliation", from: "2026-03-01", to: "2026-08-31" }, "tok-member");
  ok("W no ids at all (plain read, non-admin) -> 4xx, zero DataDoe, zero writes", noIds.status >= 400 && noIds.status < 500 && noIds.datadoe.length === 0 && noIds.writes.length === 0);
}

// =====================================================================================================================
// K. the export-boundary backstop (lib/server/datadoe.js): inside an api/datadoe.js request, createExport refuses
//    unless the request is a confirmed admin's -- BEFORE any network call; code outside a request (the scheduler, the
//    admin Data Sync Center runtime, the Ads sync) is unaffected; concurrent requests never share the flag
// =====================================================================================================================
{
  const DDL = await import("../lib/server/datadoe.js");
  const tryCreate = async () => {
    const before = net.datadoe.length;
    try { await DDL.createExport("k", "src", ["date"], ["S1"], "2026-09-01", AS_OF, 10); return { code: "ok", calls: net.datadoe.length - before }; }
    catch (e) { return { code: e && e.code ? e.code : String(e && e.message), calls: net.datadoe.length - before }; }
  };
  const denied = await DDL.withPaidExportAuthorization(() => tryCreate());
  ok("K inside a request that is NOT a confirmed admin's, createExport refuses (PAID_EXPORT_NOT_AUTHORIZED) with ZERO network calls",
    denied.code === "PAID_EXPORT_NOT_AUTHORIZED" && denied.calls === 0);
  const allowed = await DDL.withPaidExportAuthorization(() => { DDL.allowPaidExportsForThisRequest(true); return tryCreate(); });
  ok("K inside a confirmed admin's request, createExport proceeds to the export POST (refused here only by the test's DataDoe stub)",
    allowed.calls === 1 && allowed.code !== "PAID_EXPORT_NOT_AUTHORIZED");
  const outside = await tryCreate();
  ok("K outside any api/datadoe.js request (scheduler / admin runtime / Ads sync), createExport is unaffected", outside.calls === 1 && outside.code !== "PAID_EXPORT_NOT_AUTHORIZED");
  const [a, b] = await Promise.all([
    DDL.withPaidExportAuthorization(async () => { DDL.allowPaidExportsForThisRequest(true); await new Promise((r) => setTimeout(r, 5)); return tryCreate(); }),
    DDL.withPaidExportAuthorization(async () => { await new Promise((r) => setTimeout(r, 1)); return tryCreate(); }),
  ]);
  ok("K two interleaved requests keep their own flag: the admin's proceeds, the non-admin's is refused", a.code !== "PAID_EXPORT_NOT_AUTHORIZED" && b.code === "PAID_EXPORT_NOT_AUTHORIZED");
  ok("K the typed refusal maps to 403 in the route (isPaidExportNotAuthorizedError)", DDL.isPaidExportNotAuthorizedError(new DDL.PaidExportNotAuthorizedError()) && new DDL.PaidExportNotAuthorizedError().status === 403);
}

// =====================================================================================================================
// S. structural: the gate precedes every refreshable builder / export / directory discovery in handleDataDoe
// =====================================================================================================================
{
  const src = readFileSync(path.join(ROOT, "api", "datadoe.js"), "utf8").replace(/\r\n/g, "\n");
  const body = src.slice(src.indexOf("async function handleDataDoe(req, res) {"));
  const gate = body.indexOf("if (wantsRefresh(req) && !routeOwnedRefreshKey && access.role !== \"admin\") {");
  const builderCalls = [...body.matchAll(/refresh: wantsRefresh\(req\)|beginSharedRefresh\(|orchestrateBrandCatalogAction\(|discoverConnectedAccounts\(|ddFetch\(ENDPOINTS\.exportsCreate/g)].map((m) => m.index);
  ok("S the gate exists once, after the route-owned classification and the account/brand authorization",
    gate > 0 && body.indexOf("if (wantsRefresh(req) && !routeOwnedRefreshKey && access.role !== \"admin\") {", gate + 1) === -1
    && body.indexOf("const routeOwnedRefreshKey") < gate && body.indexOf("assertAccountAccess(access, publicAccountIds)") < gate);
  ok(`S the gate precedes EVERY refreshable builder, Catalog sync, directory discovery and direct export call in handleDataDoe (${builderCalls.length} found), so a future paid builder below it is covered`,
    builderCalls.length >= 12 && builderCalls.every((i) => i > gate));
  ok("S the export-boundary backstop wraps EVERY request (handler) and is set from the authenticated role immediately after getDashboardAccess",
    /withDataDoeDeadline\(Date\.now\(\) \+ ROUTE_DATADOE_BUDGET_MS, \(\) => withPaidExportAuthorization\(\(\) => handleDataDoe\(req, res\)\)\)/.test(src)
    && /const access = await getDashboardAccess\(req\);\n(\s*\/\/[^\n]*\n)*\s*allowPaidExportsForThisRequest\(access\.role === "admin"\);/.test(body));
  const sampleAssert = body.indexOf("assertPaidExportAuthorized(); // the direct export POST below");
  ok("S the admin sample's direct export POST passes the backstop first", sampleAssert > 0 && sampleAssert < body.indexOf("ddFetch(ENDPOINTS.exportsCreate"));
  const defense = body.indexOf("if (!legacySharedRefresh && access.role !== \"admin\" && LEGACY_DATADOE_BUILDER_ACTIONS.has(action)) {");
  const legacyBranches = ["accounts", "sales", "reconciliation", "sku-pl", "keyword-rank", "content-changes"].map((a) => body.indexOf(`    if (action === "${a}") {`));
  ok("S defense in depth: a non-admin without a refresh session is refused BEFORE every legacy DataDoe builder branch (accounts / sales / reconciliation / sku-pl / keyword-rank / content-changes)",
    defense > gate && legacyBranches.every((i) => i > defense));
  ok("S an account-scoped ids value that names no account is blanked before any builder sees it",
    /if \(accountScope\) req\.query\.ids = accountScope\.rawAccountIds\.join\(","\);\n(\s*\/\/[^\n]*\n)*\s*else if \(accountScopedAction\) req\.query\.ids = "";/.test(body));
}

out(`\npaid-refresh-authz: ${passed} passed`);
