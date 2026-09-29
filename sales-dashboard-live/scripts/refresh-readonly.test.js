// Publication recovery WP10b -- refresh=1 is READ-ONLY for every ROUTE-OWNED live report, the explicit PAID sync stays
// available ONLY through the admin Data Sync Center action (preview -> token estimate -> signed confirmation), and every
// Scheduler-v1 entry point refuses route-owned keys. Fully offline:
//   A  the key contract: api/datadoe.js action map == report-store ROUTE_OWNED_LIVE_REPORT_KEYS == the DB writer-fence seed;
//      every route-owned report names >= 1 real Data Sync Center card; the card -> report map is the inverse.
//   B  the REAL api/datadoe.js handler over an emulated Supabase (global fetch stub; DataDoe host REFUSED): for EVERY
//      route-owned key, refresh=1 -> ZERO DataDoe requests, ZERO non-GET Supabase requests (no lock / save / RPC /
//      delete), HTTP 200 + { refreshReadOnly: true, paidSync: { available (admin), how, cards } }, authz unchanged; the
//      refresh=1 payload equals the non-refresh read (serve parity) where the serve has no read-only re-derive; a
//      non-refresh GET carries no notice; a MANUAL-PAID insight refresh still claims its lock and reaches DataDoe.
//   C  report-store.js structural backstop: beginSharedRefresh refuses typed; serveSharedReport(refresh:true) never builds
//      or writes; selfHealFromDurable(readOnly:false) never writes -- for all 10 keys; unfenced keys unchanged.
//   D  the four retired paid builders (brand-sales / brand-inventory / daily / fba-plan) contain no DataDoe fetch and
//      end in the typed refusal; brand-sales-live.js exports no writer.
//   E  api/admin/sources.js paid sync (WP10b fix): non-admin refused; missing / expired / tampered / wrong-scope / v1
//      token -> 428 with the estimate but NO token (tokens only from preview:true) BEFORE any runtime / audit / DataDoe;
//      the preview runs the RUNTIME's own planners (OLI/Catalog: planBucketSourceSync + frozen pricing, parity-proven
//      against the verifier's new-account / weekly-slice / gap scenarios; Campaign Ads: planCampaignAdsRegionRun + the
//      bisection fallback; FBA: the exact plan) -> expected / worst case / approved ceiling separately; a card with no
//      read-only planner is not executable; the execute threads the REMAINING approval (debited from PERSISTED spend)
//      into the runtime gates, binds the token to the server as-of (409 on a UTC roll) and to ONE operation (409
//      FINISHED / CHANGED), and returns a continuation token recording the bound cycle; every Campaign-Ads step is
//      SINGLE-USE (a durable receipt per (nonce, Ads slice sequence) claimed before the runner; replay -> 409
//      PAID_SYNC_TOKEN_CONSUMED) and the approval figures returned after an Ads slice are post-slice.
//   F  Scheduler v1: api/admin/sync.js POST, api/sync.js POST, api/cron/sync.js refuse route-owned keys (typed 409, zero
//      audit / dispatch); non-route-owned keys keep their behaviour; PATCH (schedule control) unchanged.
//   G  frontend wiring: "Reload saved data" + admin-only "Request paid sync (uses DataDoe tokens)" -> Data Sync Center;
//      the DSC sends preview:true then the confirmation / continuation token on every poll, shows the server message,
//      and re-confirms via a NEW preview on 409/428; no new api/*.js function.
//   H  the runtime approval gates (zero-create refusals; absent parameter = unchanged): runBucketSourceSync (fresh plan
//      over the approval; a continuation that would cross it), runSourceCardAction (cycle-cache refused), runReleaseSlice
//      (the release Catalog), runCampaignAdsBucketSlice (bisection capped BEFORE the POST; over-cap plan -> zero creates).
// Diagnostic aid: RRO_DEBUG=1 node scripts/refresh-readonly.test.js prints a failing refresh's status / writes / DataDoe.
// 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(path.join(ROOT, ...p.split("/")), "utf8").replace(/\r\n/g, "\n");
let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; out("  ok  " + name); };
out("refresh-readonly");

// ---- env BEFORE any server module loads (module-level consts capture it) --------------------------------------------
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = ["test", "svc", "role", "key"].join("-");
process.env.DATADOE_API_KEY = ["test", "datadoe", "key"].join("-");
delete process.env.DATADOE_API_KEY_SECONDARY;
delete process.env.LHV3_PUBLISH_LIVE;
delete process.env.LISTING_HEALTH_V3;
delete process.env.PAID_SYNC_CONFIRM_SECRET;

// ---- the emulated Supabase + a REFUSING DataDoe -----------------------------------------------------------------------
const ACC = "ACCTIN0001";
const AS_OF = "2026-09-25";
const net = { gets: [], writes: [], datadoe: [] };
const row = (reportKey, payload, params = {}) => ({
  id: "row-" + reportKey, report_key: reportKey, account_id: ACC, params_hash: "seeded", params: { ...params },
  payload, payload_bytes: 100, payload_storage_path: null,
  source_refreshed_at: "2026-09-25T01:00:00.000Z", updated_at: "2026-09-25T01:00:01.000Z", created_at: "2026-09-25T01:00:01.000Z",
});
const SEED = {
  "account-directory": row("account-directory", { accounts: [{ id: ACC, name: "Acct IN", country: "IN", currency: "INR", active: true }] }, { reportVersion: "account-directory-shared-v1" }),
  "brand-sales": row("brand-sales", { rows: [{ date: "2026-09-24", child_asin: "B0A", brand: "Acme", product_brand: "Acme", marketplace_country_code: "IN", total_sales: 10, total_units: 1, total_units_sold: 1, currency: "INR" }], catalogBrands: ["Acme"], asinBrand: { B0A: "Acme" } }, { reportVersion: "brand-sales-shared-v1", from: "2025-08-01", to: AS_OF }),
  "daily-reporting": row("daily-reporting", { rows: [{ date: "2026-09-24", total_sales: 10 }], brandFiltered: false }, { reportVersion: "daily-reporting-shared-v2", from: "2026-04-01", to: AS_OF, brand: "ALL" }),
  "brand-inventory": row("brand-inventory", { accountId: ACC, inventoryDate: "2026-09-24", inventoryAvailable: true, inventoryByBrandCountry: [] }, { reportVersion: "brand-inventory-shared-v1", to: AS_OF }),
  "fba-plan": row("fba-plan", { asOf: AS_OF, rows: [], inventoryAvailable: true }, { reportVersion: "fba-plan-shared-v1", to: AS_OF }),
  "sku-movement": row("sku-movement", { rows: [], effectiveAsOf: "2026-09-24" }, { reportVersion: "sku-movement/v2", asOf: "2026-09-24", brand: "ALL" }),
  "returns-leakage": row("returns-leakage", { rows: [], window: { days: 90 } }, { reportVersion: "returns-leakage-v3", to: AS_OF }),
  "brand-view-brands": row("brand-view-brands", { accountId: ACC, brands: ["Acme"], sources: [], message: null }, { reportVersion: "brand-view-brands-v1", accountId: ACC }),
  "brand-view": row("brand-view", { rows: [], countries: [], coverage: {} }, { reportVersion: "x", brand: "Acme", asOf: AS_OF }),
  "brand-view-portfolio": row("brand-view-portfolio", { rows: [], countries: [], coverage: {} }, { reportVersion: "x", brand: "Acme", asOf: AS_OF }),
  "listing-health-v3": row("listing-health-v3", { rows: [] }, { reportVersion: "x", to: "2026-09-24" }),
};
const HIDE = new Set(); // report keys the emulator pretends have NO published row (P3-5 read-only build proof)
const READ_ONLY_RPCS = new Set(["/rest/v1/rpc/resolve_oli_sku_asin"]);
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = String(opts.method || "GET").toUpperCase();
  if (!u.startsWith("http://supabase.test")) { net.datadoe.push(method + " " + u); throw new Error("DATADOE_CALL_REFUSED_BY_TEST"); }
  const p = u.slice("http://supabase.test".length);
  if (p.startsWith("/auth/v1/user")) {
    const tok = String((opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || "").replace(/^Bearer /, "");
    return tok === "tok-admin" ? jsonRes(200, { id: "u-admin", email: "a@x" }) : tok === "tok-member" ? jsonRes(200, { id: "u-member", email: "m@x" }) : jsonRes(401, { msg: "no" });
  }
  // A STABLE read-only SQL function PostgREST exposes as a POST RPC (20260911: language sql STABLE) is a READ, not a write.
  if (method === "POST" && READ_ONLY_RPCS.has(p.split("?")[0])) { net.gets.push(p); return jsonRes(200, []); }
  if (method !== "GET") {
    net.writes.push(method + " " + p.split("?")[0]);
    if (p.startsWith("/rest/v1/rpc/claim_report_refresh_lock")) return jsonRes(200, true);
    return jsonRes(200, []);
  }
  net.gets.push(p.split("?")[0]);
  const q = new URLSearchParams(p.split("?")[1] || "");
  if (p.startsWith("/rest/v1/user_profiles")) return jsonRes(200, [{ role: /u-admin/.test(q.get("user_id")) ? "admin" : "member", display_name: "t" }]);
  if (p.startsWith("/rest/v1/account_permissions")) return jsonRes(200, /u-member/.test(q.get("user_id")) ? [{ account_id: ACC, brand_scope_mode: "ALL_BRANDS" }] : []);
  if (p.startsWith("/rest/v1/report_snapshots")) {
    const k = (q.get("report_key") || "").replace(/^eq\./, "");
    return jsonRes(200, SEED[k] && !HIDE.has(k) ? [SEED[k]] : []);
  }
  return jsonRes(200, []);
};
const fakeRes = () => ({ statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} });

// ---- modules (after env + fetch) ---------------------------------------------------------------------------------------
const RS = await import("../lib/server/report-store.js");
const FENCE = await import("../lib/server/sync/report-writer-fence.js");
const DD = await import("../api/datadoe.js");
const SRC = await import("../api/admin/sources.js");
const ADMIN_SYNC = await import("../api/admin/sync.js");
const V1_SYNC = await import("../api/sync.js");
const CRON_SYNC = await import("../api/cron/sync.js");
const REG = await import("../lib/server/sync/source-registry.js");
const OPS = await import("../lib/server/sync/source-sync-operation.js");
const { isAdsRegistryKeyRetired } = await import("../lib/server/active-ads-source.js");
const J = (v) => JSON.stringify(v);
const SORT = (a) => [...a].sort();

// =====================================================================================================================
// A. the key contract
// =====================================================================================================================
{
  ok("A1 the api/datadoe.js route-owned action map covers EXACTLY the 10 route-owned live keys == report-store == the writer-fence seed",
    J(SORT(Object.values(DD.ROUTE_OWNED_ACTION_REPORT_KEYS))) === J(SORT(RS.ROUTE_OWNED_LIVE_REPORT_KEYS))
    && J(SORT(RS.ROUTE_OWNED_LIVE_REPORT_KEYS)) === J(SORT(FENCE.FENCED_WRITER_REPORT_KEYS)) && RS.ROUTE_OWNED_LIVE_REPORT_KEYS.length === 10);
  const cardKeys = new Set(REG.SOURCE_REGISTRY.map((e) => e.sourceKey));
  const every = RS.ROUTE_OWNED_LIVE_REPORT_KEYS.every((k) => {
    const d = RS.routeOwnedPaidSync(k, { isAdmin: true });
    return d && d.available === true && d.cards.length >= 1 && d.cards.every((c) => cardKeys.has(c) && !isAdsRegistryKeyRetired(c)) && typeof d.how === "string" && d.how.length > 40
      && d.surface === "data-sync-center" && d.endpoint === "POST /api/admin/sources" && RS.routeOwnedPaidSync(k, { isAdmin: false }).available === false;
  });
  ok("A2 every route-owned report names >= 1 REAL, non-retired Data Sync Center card + a how; available only for an admin", every);
  ok("A3 routeOwnedPaidSync is null for a manual-paid insight report (it keeps its own paid refresh)", ["sales-movers", "listing-health", "buy-box-loss", "ppc-performance", "listing-optimizer", "reconciliation", "sku-pl", "keyword-rank", "content-changes", "sales", "brand-portfolio"].every((k) => RS.routeOwnedPaidSync(k) === null && !RS.isRouteOwnedLiveReportKey(k)));
  const olis = RS.routeOwnedReportsForPaidSyncCard("order-line-items");
  ok("A4 the card -> report inverse: the OLI card refreshes the priority trio directly (priority release) and the rest via routes; the FBA card publishes fba-plan directly",
    ["brand-sales", "daily-reporting", "brand-inventory", "sku-movement", "returns-leakage", "brand-view"].every((k) => olis.includes(k))
    && J(SRC.paidSyncCardRefreshes("order-line-items").direct) === J(SORT(OPS.SOURCE_DASHBOARD_DEPENDENCIES["order-line-items"].reports))
    && J(SRC.paidSyncCardRefreshes("fba-inventory-health").direct) === J(["fba-plan"])
    && SRC.paidSyncCardRefreshes("fba-inventory-health").viaRoutes.includes("brand-inventory") && !SRC.paidSyncCardRefreshes("order-line-items").viaRoutes.includes("daily-reporting"));
}

// =====================================================================================================================
// B. the REAL api/datadoe.js handler: refresh=1 is READ-ONLY for every route-owned key
// =====================================================================================================================
const REQS = {
  "brand-sales": { action: "brand-sales", ids: ACC, from: "2025-08-01", to: AS_OF },
  "daily-reporting": { action: "daily", ids: ACC, from: "2026-04-01", to: AS_OF, brand: "ALL" },
  "brand-inventory": { action: "brand-inventory", ids: ACC, to: AS_OF },
  "listing-health-v3": { action: "listing-health-v3", ids: ACC, to: AS_OF },
  "fba-plan": { action: "fba-plan", ids: ACC, to: AS_OF },
  "sku-movement": { action: "sku-movement", ids: ACC, to: AS_OF, brand: "ALL" },
  "returns-leakage": { action: "returns-leakage", ids: ACC, to: AS_OF },
  "brand-view": { action: "brand-view", ids: ACC, brand: "Acme", asOf: AS_OF },
  "brand-view-portfolio": { action: "brand-view-portfolio", ids: ACC, brand: "Acme", asOf: AS_OF },
  "brand-view-brands": { action: "brand-view-brands", ids: ACC },
};
// The serves that ALREADY re-derive read-only on a refresh (returns: skips the stored row; brand-view-brands: rebuilds
// the directory) answer differently from a plain read by design; every other key serves exactly the read's payload.
const REDERIVE_ON_REFRESH = new Set(["returns-leakage", "brand-view-brands"]);
const strip = (b) => { if (!b || typeof b !== "object") return b; const { refreshReadOnly, paidSync, ...rest } = b; void refreshReadOnly; void paidSync; return rest; };
async function call(query, token) {
  const res = fakeRes();
  const before = { d: net.datadoe.length, w: net.writes.length };
  await DD.default({ method: "GET", query: { ...query }, headers: { authorization: "Bearer " + token } }, res);
  return { res, datadoe: net.datadoe.slice(before.d), writes: net.writes.slice(before.w) };
}
for (const [key, q] of Object.entries(REQS)) {
  for (const who of ["admin", "member"]) {
    const token = "tok-" + who;
    // WP10b fix (P3-4): brand-inventory refresh=1 is read-only, so its former admin-only gate is gone -- a member gets the
    // SAME read-only serve (paidSync.available:false) as every other route-owned key (asserted by the loop below).
    const refreshed = await call({ ...q, refresh: "1" }, token);
    const b = refreshed.res.body || {};
    if (process.env.RRO_DEBUG && !(refreshed.res.statusCode === 200 && refreshed.datadoe.length === 0 && refreshed.writes.length === 0)) out("DEBUG " + key + " " + refreshed.res.statusCode + " " + J(refreshed.writes) + " " + J(refreshed.datadoe) + " " + J(b).slice(0, 400));
    ok(`B ${key} (${who}) refresh=1: HTTP 200, ZERO DataDoe requests, ZERO report_snapshots / lock / RPC writes`,
      refreshed.res.statusCode === 200 && refreshed.datadoe.length === 0 && refreshed.writes.length === 0);
    ok(`B ${key} (${who}) refresh=1 answers refreshReadOnly:true + paidSync { available: ${who === "admin"}, how, cards }`,
      b.refreshReadOnly === true && b.paidSync && b.paidSync.available === (who === "admin") && typeof b.paidSync.how === "string"
      && J(b.paidSync.cards) === J(RS.routeOwnedPaidSync(key).cards));
    const read = await call({ ...q }, token);
    ok(`B ${key} (${who}) a NON-refresh read is unchanged: 200, zero DataDoe / writes, NO refreshReadOnly / paidSync notice`,
      read.res.statusCode === 200 && read.datadoe.length === 0 && read.writes.length === 0 && !("refreshReadOnly" in (read.res.body || {})) && !("paidSync" in (read.res.body || {})));
    if (!REDERIVE_ON_REFRESH.has(key)) {
      ok(`B ${key} (${who}) SERVE PARITY: the refresh=1 payload is EXACTLY the read's payload (+ the two notice fields)`, J(strip(b)) === J(read.res.body));
    }
  }
}
{
  const insight = await call({ action: "sales-movers", ids: ACC, to: AS_OF, refresh: "1" }, "tok-admin");
  if (process.env.RRO_DEBUG) out("DEBUG insight " + insight.res.statusCode + " " + J(insight.writes) + " " + J(insight.datadoe) + " " + J(insight.res.body).slice(0, 300));
  // The paid builder begins with the durable manual-source continuation protocol (its marker write precedes the DataDoe
  // create); in this emulation the marker read-back is empty, so it stops there as typed in-progress -- but it RAN.
  ok("B MANUAL-PAID insight refresh is UNCHANGED: sales-movers refresh=1 still claims its refresh lock and enters its paid builder (continuation marker / DataDoe), never tagged read-only",
    insight.writes.some((w) => /rpc\/claim_report_refresh_lock/.test(w)) && (insight.datadoe.length >= 1 || insight.writes.includes("POST /rest/v1/report_snapshots"))
    && !(insight.res.body && insight.res.body.refreshReadOnly) && !(insight.res.body && insight.res.body.paidSync));
}
// P3-5: a brand / as-of with NO published Brand View row. A plain read stays a no-build "missing" answer; an explicit
// reload (refresh=1) BUILDS it read-only from saved evidence and serves it -- zero DataDoe, zero lock / save / publish.
for (const key of ["brand-view", "brand-view-portfolio"]) {
  HIDE.add(key);
  try {
    for (const who of ["admin", "member"]) {
      const token = "tok-" + who;
      const read = await call({ ...REQS[key] }, token);
      const rb = read.res.body || {};
      if (process.env.RRO_DEBUG) out("DEBUG p3-5 read " + key + " " + read.res.statusCode + " " + J(rb).slice(0, 300));
      ok(`B P3-5 ${key} (${who}) with NO published row: a plain read builds NOTHING (snapshotMissing), zero DataDoe / writes`,
        read.res.statusCode === 200 && rb.snapshotMissing === true && !rb.countries && read.datadoe.length === 0 && read.writes.length === 0);
      const built = await call({ ...REQS[key], refresh: "1" }, token);
      const bb = built.res.body || {};
      if (process.env.RRO_DEBUG) out("DEBUG p3-5 build " + key + " " + built.res.statusCode + " " + J(built.writes) + " " + J(bb).slice(0, 400));
      ok(`B P3-5 ${key} (${who}) with NO published row: refresh=1 BUILDS it read-only from saved evidence (served, never stored): 200, the brand payload, snapshot.readOnly, ZERO DataDoe, ZERO lock / save / RPC writes, still tagged read-only`,
        built.res.statusCode === 200 && bb.brand === "Acme" && Array.isArray(bb.countries) && bb.countries.length >= 1 && !bb.snapshotMissing
        && bb.snapshot && bb.snapshot.readOnly === true && bb.snapshot.rederived === true
        && built.datadoe.length === 0 && built.writes.length === 0 && bb.refreshReadOnly === true && bb.paidSync && bb.paidSync.available === (who === "admin"));
    }
  } finally { HIDE.delete(key); }
}

// =====================================================================================================================
// C. report-store.js structural backstop (all 10 keys)
// =====================================================================================================================
{
  const recordingStore = () => {
    const calls = { claimRefreshLock: 0, releaseRefreshLock: 0, getReportSnapshot: 0, saveReportSnapshot: 0, publishSnapshotUpdate: 0 };
    return { calls, claimRefreshLock: async () => { calls.claimRefreshLock += 1; return true; }, releaseRefreshLock: async () => { calls.releaseRefreshLock += 1; },
      getReportSnapshot: async () => { calls.getReportSnapshot += 1; return null; }, saveReportSnapshot: async () => { calls.saveReportSnapshot += 1; return { id: "x" }; },
      publishSnapshotUpdate: async () => { calls.publishSnapshotUpdate += 1; } };
  };
  let refusedAll = true; let serveAll = true; let healAll = true;
  for (const key of RS.ROUTE_OWNED_LIVE_REPORT_KEYS) {
    const w0 = net.writes.length;
    let err = null;
    try { await RS.beginSharedRefresh({ res: fakeRes(), reportKey: key, reportVersion: "v", accountId: ACC, params: { to: AS_OF }, userId: "u", label: key }); } catch (e) { err = e; }
    if (!(err && err.code === RS.ROUTE_OWNED_REPORT_READ_ONLY && err.status === 409 && err instanceof RS.RouteOwnedReportReadOnlyError) || net.writes.length !== w0) refusedAll = false;
    let builds = 0;
    const res = fakeRes();
    await RS.serveSharedReport({ res, refresh: true, reportKey: key, reportVersion: "v", accountId: ACC, params: { to: AS_OF }, label: key, build: async () => { builds += 1; return { rows: [] }; } });
    if (builds !== 0 || net.writes.length !== w0 || res.statusCode !== 200) serveAll = false;
    const store = recordingStore();
    const r2 = fakeRes();
    await RS.selfHealFromDurable({ deriveDurable: async () => ({ payload: { rows: [] } }), reportKey: key, reportVersion: "v", accountId: ACC, paramsHash: "h", params: {}, res: r2, label: key, lockSeconds: 60, readOnly: false }, store);
    if (store.calls.saveReportSnapshot || store.calls.claimRefreshLock || store.calls.publishSnapshotUpdate || !(r2.body && r2.body.snapshot && r2.body.snapshot.readOnly === true)) healAll = false;
  }
  ok("C1 beginSharedRefresh REFUSES every route-owned key typed (ROUTE_OWNED_REPORT_READ_ONLY, 409) before any lock / request", refusedAll);
  ok("C2 serveSharedReport({ refresh: true }) of every route-owned key NEVER runs the build and writes nothing (served as a read)", serveAll);
  ok("C3 selfHealFromDurable({ readOnly: false }) of every route-owned key is forced read-only: zero lock / save / publish", healAll);
  const w0 = net.writes.length;
  const sess = await RS.beginSharedRefresh({ res: fakeRes(), reportKey: "sales-movers", reportVersion: "sales-movers-v1", accountId: ACC, params: { to: AS_OF }, userId: "u", label: "Sales Movers" });
  ok("C4 an UNFENCED (manual-paid) key still opens its refresh session (claims the lock) -- the paid contract is unchanged", !!sess && net.writes.slice(w0).some((w) => /claim_report_refresh_lock/.test(w)));
  if (sess) await sess.release();
  const store = recordingStore();
  await RS.selfHealFromDurable({ deriveDurable: async () => ({ payload: { rows: [] } }), reportKey: "brand-portfolio", reportVersion: "v", accountId: ACC, paramsHash: "h", params: {}, res: fakeRes(), label: "x", lockSeconds: 60, readOnly: false }, store);
  ok("C5 ... and an unfenced key's legacy persist path (readOnly:false) still writes", store.calls.saveReportSnapshot === 1);
  const storeSrc = src("lib/server/report-store.js");
  ok("C6 every report-store write site is guarded: beginSharedRefresh + finish, the serveSharedReport refresh lock, persistDerivedSnapshot",
    (storeSrc.match(/assertNotRouteOwnedWrite\(reportKey, "/g) || []).length === 4 && /if \(refresh && isRouteOwnedLiveReportKey\(reportKey\)\) refresh = false;/.test(storeSrc)
    && /if \(!readOnly && isRouteOwnedLiveReportKey\(reportKey\)\) readOnly = true;/.test(storeSrc));
}

// =====================================================================================================================
// D. the retired paid builders + brand-sales-live
// =====================================================================================================================
{
  const api = src("api/datadoe.js");
  // One handler block: from its `if (action === ...) {` to its closing brace at the handler's 4-space indent.
  const block = (start) => { const a = api.indexOf(start); return a < 0 ? "" : api.slice(a, api.indexOf("\n    }\n", a) + 7); };
  const blocks = {
    "brand-sales": block('    if (action === "brand-sales") {'),
    "brand-inventory": block('    if (action === "brand-inventory") {'),
    "daily-reporting": block('    if (action === "daily") {'),
    "fba-plan": block('    if (action === "fba-plan") {'),
  };
  ok("D1 the four RETIRED paid builders contain NO DataDoe fetch / export / sendLegacyPayload and end in the typed refusal",
    Object.entries(blocks).every(([k, b]) => b.length > 100 && !/fetchExportRows|fetchAccountsRaw|fetchDailyBrandSalesRows|createExport|ddFetch|sendLegacyPayload|saveReportSnapshot|refreshCorrectedBrandSalesForAccount\(/.test(b)
      && new RegExp('respondRouteOwnedBuilderRetired\\(res, "' + k + '", access\\);\\s*return;\\s*\\}\\s*$').test(b.trim() + "\n")));
  ok("D2 the legacy shared block serves a route-owned refresh=1 as a READ (never beginSharedRefresh)",
    /if \(!wantsRefresh\(req\) \|\| routeOwnedRefreshKey\) \{/.test(api) && /const routeOwnedRefreshKey = wantsRefresh\(req\) \? routeOwnedReportKeyForAction\(action\) : null;/.test(api));
  ok("D3 brand-view / brand-view-portfolio pass refresh:false (never a rebuild/save); brand-view-brands keeps its read-only re-derive",
    /reportKey: BRAND_VIEW_REPORT_KEY,/.test(api) && /\/\/ WP10b: route-owned -> a refresh=1 is READ-ONLY[^\n]*\n\s*refresh: false,\n\s*reportKey: BRAND_VIEW_REPORT_KEY,/.test(api)
    && /const portfolioRefresh = false;/.test(api) && /const brandDirectory = await brandViewDirectory\(accountId, \{ rebuild: wantsRefresh\(req\) \}\);/.test(api));
  const storeSrc = src("lib/server/report-store.js");
  ok("D3b P3-5: the read-only build is OPT-IN on an explicit reload only (brand-view + portfolio pass readOnlyBuildOnMissingExact + a deriveDurable ONLY under wantsRefresh); report-store defaults it OFF and routes it through the readOnly:true self-heal",
    /\.\.\.\(wantsRefresh\(req\) \? \{ readOnlyBuildOnMissingExact: true, deriveDurable: async \(\) => \(\{ payload: await buildSingleBrandView\(\)/.test(api)
    && /const portfolioReadOnlyBuild = wantsRefresh\(req\);/.test(api) && /\.\.\.\(portfolioReadOnlyBuild \? \{ readOnlyBuildOnMissingExact: true, deriveDurable: async \(\) => \(\{ payload: await buildPortfolio\(\)/.test(api)
    && /readOnlyBuildOnMissingExact = false,/.test(storeSrc) && /if \(readOnlyBuildOnMissingExact && deriveDurable\) \{\n\s*readOnlyBuild = await selfHealFromDurable\(\{[^\n]*readOnly: true \}, store\);/.test(storeSrc));
  ok("D3c P3-4: the brand-inventory refresh=1 admin-only gate is gone (it guarded the retired PAID export; refresh=1 is read-only now)",
    !/action === "brand-inventory" && wantsRefresh\(req\)\) assertAdmin\(access\)/.test(api));
  const live = src("lib/server/reports/brand-sales-live.js").replace(/\/\/.*$/gm, "");
  ok("D4 brand-sales-live.js exports no writer (the unfenced corrected refresher is removed; only the read-only derive remains)",
    !/saveReportSnapshot|claimRefreshLock|publishSnapshotUpdate|refreshCorrectedBrandSalesForAccount/.test(live) && /export async function deriveCorrectedBrandSalesForAccount/.test(live));
}

// =====================================================================================================================
// E. the admin Data Sync Center PAID sync contract (api/admin/sources.js)
// =====================================================================================================================
const E_NOW = Date.UTC(2026, 8, 26, 3, 0); // 2026-09-26T03:00Z -> server today 2026-09-26, as-of (D-1) 2026-09-25
const E_TODAY = "2026-09-26";
const E_ASOF = "2026-09-25";
const E_CONN = { id: "primary", apiKey: ["fx", "key"].join("-"), accountPrefix: "", organizationFingerprint: "org-fp" };
const FRESH_CATALOG = { validated_at: E_TODAY + "T01:00:00.000Z", object_path: "p", row_count: 1 };
const STEADY = [{ from: "2025-01-01", to: E_ASOF }];
// ONE offline paid-sync environment: every durable reader the preview / execute binding uses is injected (ZERO network).
// Each environment is its own admin (the route's per-admin manual-run rate limit is 30 / 10 min).
let paidEnvSeq = 0;
function paidEnv(over = {}) {
  const uid = over.userId || ("admin-e" + (paidEnvSeq += 1));
  const st = {
    directory: over.directory || [], coverage: over.coverage || {}, heads: over.heads || {}, jobs: over.jobs || {},
    budgets: over.budgets || {}, reservation: over.reservation === undefined ? null : over.reservation,
    adsCoverage: over.adsCoverage || {}, truncatedScope: over.truncatedScope || null,
    controls: over.controls || { rows: [], read: "ok" }, headThrows: false, directoryThrows: !!over.directoryThrows,
    receipts: new Set(), // the Campaign-Ads single-use receipts (audit_log primary-key emulation: insert-if-absent)
  };
  const calls = { audit: 0, runtimeBuilt: 0, preflight: 0, cardAction: [], run: [], ads: [], directory: 0, dataDoe: 0 };
  const runtime = {
    makeDeadline: () => ({ deadlineMs: Date.now() + 60_000, reserveMs: 3000, outOfTime: () => false, isDeadlineError: () => false, ensureTime: async () => {}, bound: async (_l, fn) => fn(() => {}) }),
    preflightEvidence: async () => { calls.preflight += 1; if (over.preflightThrows) throw Object.assign(new Error("REACHED_PREFLIGHT"), { code: "REACHED_PREFLIGHT" }); return { today: over.preflightToday || E_TODAY, evidence: {} }; },
    runSourceCardAction: async (a) => { calls.cardAction.push(a); return over.cardResult ? over.cardResult(a) : { refused: false, continuationRequired: true }; },
    run: async (a) => { calls.run.push(a); return over.runResult ? over.runResult(a) : { globalDrained: false, continuationRequired: true }; },
    gatherDurableReadiness: async () => ({ unavailable: "test" }),
  };
  const deps = {
    getDashboardAccess: over.getDashboardAccess || (async () => ({ userId: uid, role: "admin" })),
    assertAdmin: over.assertAdmin || (() => {}),
    isAdsRegistryKeyRetired,
    insertAuditLog: async () => { calls.audit += 1; },
    setSourceControl: async () => ({ ok: true }),
    getSourceControls: async () => st.controls,
    getSourceRunStatuses: async () => ({ rows: [{ source_key: "order-line-items", bucket: "non-us", tokens_spent: 4, tokens_ceiling: 6, creates_spent: 2, creates_ceiling: 3 }], read: "ok" }),
    getAccountDirectoryRows: async () => { calls.directory += 1; if (st.directoryThrows) throw new Error("directory down"); return st.directory; },
    getAccountOliQualityCounts: async () => ({}),
    primaryOrganizationFingerprint: () => "org-fp",
    buildBucketSourceSyncRuntime: () => { calls.runtimeBuilt += 1; return runtime; },
    now: over.now || (() => E_NOW),
    getDataDoeConnections: () => [E_CONN],
    resolveDataDoeAccountIds: (ids) => ({ connection: E_CONN, accountIds: ids, rawAccountIds: ids }),
    getSourceCoverageWindows: async ({ accountId }) => ({ read: "ok", windows: st.coverage[accountId] || [] }),
    getSourceSnapshot: async ({ sourceKey }) => ({ read: "ok", snapshot: sourceKey === "product-catalog" ? FRESH_CATALOG : null }),
    listSourceBatchMembership: async () => [],
    getSourceTrancheBudget: async ({ cycleId, trancheKey }) => st.budgets[cycleId + "|" + trancheKey] || null,
    getSourceExportCacheMeta: async () => null,
    getSourceExportCache: async () => null,
    getRecentSyncCycleIds: async () => (st.truncatedScope ? ["old-cycle"] : []),
    getSyncSourceJobsWithMeta: async (cid) => (st.truncatedScope && cid === "old-cycle" ? [{ request_hash: "HTRUNC", source_key: "order-line-items", fetch_status: "failed", error_code: "TRUNCATED", terminal: true }] : []),
    getSyncSourceJobOwnersForCycle: async (cid) => (st.truncatedScope && cid === "old-cycle" ? [{ request_hash: "HTRUNC", request_key: "source-oli:slice-v1", account_scope_hash: st.truncatedScope, connection_id: "primary", organization_fingerprint: "org-fp", owner_status: "active" }] : []),
    getSyncCycleByBucketDate: async (b, d) => { if (st.headThrows) throw new Error("cycle slot fork"); return st.heads[b + "|" + d] || null; },
    getSyncSourceJobs: async (cid) => st.jobs[cid] || [],
    getPriorityCatalogReservation: async () => st.reservation,
    getDailyAdsCoverage: async (accountId) => st.adsCoverage[accountId] || { read: "ok", windows: [], status: "missing" },
    runCampaignAdsBucketSlice: async (a) => { calls.ads.push(a); return over.adsResult ? over.adsResult(a) : { phase: "sync", continuationRequired: true, creates: 2, tokens: 4 }; },
    claimPaidSyncReceipt: async ({ receiptId }) => { if (st.receipts.has(receiptId)) return { claimed: false, reason: "consumed" }; st.receipts.add(receiptId); return { claimed: true }; },
    ...over.extra,
  };
  return { deps, calls, st, uid };
}
const dirRow = (id, country, bucket) => ({ account_id: id, marketplace_country_code: country, sync_bucket: bucket, name: id, currency: "INR" });
const post = async (env, body) => { const r = fakeRes(); await SRC.handler({ method: "POST", body }, r, env.deps); return r; };
const previewOf = async (env, body) => { const r = await post(env, { ...body, preview: true }); return r.body && r.body.preview; };
const claimsOf = (env, token, scope) => RS.verifyPaidSyncConfirmation(token, { userId: env.uid, refreshMode: "normal", now: E_NOW, ...scope });
const oliFam = (pv) => (pv.estimate.families || []).find((f) => f.sourceKey === "order-line-items");
await (async () => {
  const SBS = await import("../lib/server/sync/source-bucket-sync.js");
  const TB = await import("../lib/server/sync/source-tranche-budget.js");
  const TR = await import("../lib/server/sync/source-tranche.js");
  const SID = await import("../lib/server/source-identity.js");
  const EST = await import("../lib/server/sync/paid-sync-estimate.js");
  // The runtime's OWN plan for the same inputs (the verifier's probe method): the frozen OLI ceiling it would persist.
  const runtimeOliTokens = ({ ids, coverage, weekly = new Set() }) => {
    const accounts = ids.map((id) => ({ accountId: id, rawSellerId: id, country: "IN", name: id, currency: "INR" }));
    const paused = new Set(REG.SOURCE_REGISTRY.map((e) => e.sourceKey).filter((k) => k !== "order-line-items"));
    const plan = SBS.planBucketSourceSync({ apiKey: E_CONN.apiKey, bucket: "non-us", accounts, existingMembership: new Map(), coverageByAccountId: coverage, catalogSnapshot: FRESH_CATALOG, pausedSources: paused, asOf: E_ASOF, today: E_TODAY, catalogCarrierSeller: [...ids].sort()[0], oliBackfillWeeklySellers: weekly });
    const fam = plan.families.find((f) => f.sourceKey === "order-line-items");
    return TB.computeFrozenTrancheBudget({ plannedJobs: fam.plannedJobs, sourceTranche: TR.makeSourceTranche({ name: "order-line-items", sourceKeys: ["order-line-items"] }), isPremiumOf: REG.registryIsPremiumOf, trancheKey: "source-sync:order-line-items" }).maxTokens;
  };
  const structuralOliTokens = (n) => Math.ceil(n / 5) * 2; // the retired registry formula (one export per batch)
  const six = ["A1", "A2", "A3", "A4", "A5", "A6"];
  const steadyCov = (ids) => Object.fromEntries(ids.map((id) => [id, STEADY]));

  // E1 non-admin
  const na = paidEnv({ assertAdmin: () => { throw Object.assign(new Error("Admin only."), { status: 403 }); } });
  const r1 = await post(na, { bucket: "non-us", sourceKey: "order-line-items", preview: true });
  ok("E1 a NON-admin can neither preview nor run the paid sync (403 before any read)", r1.statusCode === 403 && na.calls.directory === 0 && na.calls.runtimeBuilt === 0 && na.calls.audit === 0);

  // E2 missing confirmation -> 428 + estimate, NO token (P3-2), zero spend
  const m = paidEnv({ directory: six.map((id) => dirRow(id, "IN", "non-us")), coverage: steadyCov(six) });
  const r2 = await post(m, { bucket: "non-us", sourceKey: "order-line-items" });
  ok("E2 an execute POST WITHOUT confirmation fails CLOSED: 428 PAID_SYNC_CONFIRMATION_REQUIRED, ZERO runtime / preflight / audit / DataDoe",
    r2.statusCode === 428 && r2.body.error === "PAID_SYNC_CONFIRMATION_REQUIRED" && m.calls.runtimeBuilt === 0 && m.calls.preflight === 0 && m.calls.audit === 0 && m.calls.cardAction.length === 0);
  ok("E2b P3-2: the 428 carries the estimate but NO confirmationToken (a token only ever comes from an explicit preview:true)",
    r2.body.preview && r2.body.preview.estimate && r2.body.preview.estimate.worstCaseTokens > 0 && r2.body.preview.confirmationToken === null && r2.body.preview.expiresAt === null);

  // E3 the OLI preview is the RUNTIME planner
  const pv = await previewOf(m, { bucket: "non-us", sourceKey: "order-line-items" });
  const of = oliFam(pv);
  ok("E3 the OLI preview runs the runtime planner: 6 steady accounts -> 2 canonical batch exports (4 tokens) expected + worst, + the release Catalog (2): expected 6 / worst 6 / approved 6, priced per create, with assumptions + the one operation",
    pv.estimate.basis === "runtime-planner" && of && of.basis === "frozen-plan" && of.worstCaseTokens === 4 && of.expectedTokens === 4 && of.tokensPerExport === 2
    && pv.estimate.release && pv.estimate.release.reserveTokens === 2 && pv.estimate.expectedTokens === 6 && pv.estimate.worstCaseTokens === 6
    && pv.approvedMaxTokens === 6 && pv.estimate.approvedCeilingTokens === 6 && pv.estimate.tokensPerCreate.standard === 2 && pv.estimate.tokensPerCreate.premium === 5
    && pv.estimate.assumptions.length >= 4 && pv.estimate.lastRun && pv.estimate.lastRun.tokensSpent === 4
    && pv.operation.key === "non-us/" + E_TODAY && pv.operation.asOf === E_ASOF && pv.operation.cycleId === null && pv.operation.baselineTokens === 0
    && typeof pv.confirmationToken === "string" && pv.confirmationToken.length > 40 && J(pv.refreshes.direct) === J(["brand-inventory", "brand-sales", "daily-reporting"]));
  // E3b PARITY with the verifier's probe scenarios: the preview's worst case IS the runtime's frozen OLI plan, and the
  // retired structural formula under-stated every one of them.
  const newAcct = { directory: six.map((id) => dirRow(id, "IN", "non-us")), coverage: steadyCov(six.slice(0, 5)) };
  const pNew = await previewOf(paidEnv(newAcct), { bucket: "non-us", sourceKey: "order-line-items" });
  const expNew = runtimeOliTokens({ ids: six, coverage: { ...steadyCov(six.slice(0, 5)), A6: [] } });
  const scopeA6 = SID.accountScopeHash(["A6"]);
  const pWeekly = await previewOf(paidEnv({ ...newAcct, truncatedScope: scopeA6 }), { bucket: "non-us", sourceKey: "order-line-items" });
  const expWeekly = runtimeOliTokens({ ids: six, coverage: { ...steadyCov(six.slice(0, 5)), A6: [] }, weekly: new Set(["A6"]) });
  const five = six.slice(0, 5);
  const gapCov = { ...steadyCov(five), A3: [{ from: "2025-01-01", to: "2026-03-01" }, { from: "2026-04-01", to: E_ASOF }] };
  const pGap = await previewOf(paidEnv({ directory: five.map((id) => dirRow(id, "IN", "non-us")), coverage: gapCov }), { bucket: "non-us", sourceKey: "order-line-items" });
  const expGap = runtimeOliTokens({ ids: five, coverage: gapCov });
  if (process.env.RRO_DEBUG) out("DEBUG parity new=" + oliFam(pNew).worstCaseTokens + "/" + expNew + " weekly=" + oliFam(pWeekly).worstCaseTokens + "/" + expWeekly + " gap=" + oliFam(pGap).worstCaseTokens + "/" + expGap);
  ok("E3b PARITY (verifier probe): a NEW account's multi-chunk backfill, a truncation-proven WEEKLY-sliced seller and a coverage GAP inside a batch are priced EXACTLY as the runtime's frozen OLI plan -- each strictly above the retired one-export-per-batch formula",
    oliFam(pNew).worstCaseTokens === expNew && expNew > structuralOliTokens(6)
    && oliFam(pWeekly).worstCaseTokens === expWeekly && expWeekly > expNew && oliFam(pWeekly).weeklySlicedSellers === 1
    && oliFam(pGap).worstCaseTokens === expGap && expGap > structuralOliTokens(5)
    && pWeekly.approvedMaxTokens === expWeekly + 2 && pWeekly.estimate.followOnSplit && pWeekly.estimate.followOnSplit.tokens > 0);

  // E4 preview:true is zero-write
  ok("E4 an explicit preview:true is 200 with the estimate and ZERO writes / runtime / DataDoe", pv.estimate.expectedTokens === 6 && m.calls.audit === 0 && m.calls.runtimeBuilt === 0);

  // E5 wrong scope / tampered / expired / v1 tokens
  const tok = pv.confirmationToken;
  const tries = [
    ["another card", { bucket: "non-us", sourceKey: "product-catalog", confirmationToken: tok }, "scope-mismatch"],
    ["another bucket", { bucket: "us", sourceKey: "order-line-items", confirmationToken: tok }, "scope-mismatch"],
    ["another refresh mode", { bucket: "non-us", sourceKey: "order-line-items", refreshMode: "force-latest", confirmationToken: tok }, "scope-mismatch"],
    ["a tampered token", { bucket: "non-us", sourceKey: "order-line-items", confirmationToken: tok.slice(0, -2) + (tok.endsWith("AA") ? "BB" : "AA") }, "bad-signature"],
  ];
  let allRefused = true;
  for (const [, body, reason] of tries) {
    const r = await post(m, body);
    if (!(r.statusCode === 428 && r.body.error === "PAID_SYNC_CONFIRMATION_INVALID" && r.body.reason === reason && r.body.preview && r.body.preview.confirmationToken === null)) allRefused = false;
  }
  const other = paidEnv({ directory: six.map((id) => dirRow(id, "IN", "non-us")), coverage: steadyCov(six) });
  const r5 = await post(other, { bucket: "non-us", sourceKey: "order-line-items", confirmationToken: tok });
  const late = paidEnv({ userId: m.uid, directory: six.map((id) => dirRow(id, "IN", "non-us")), coverage: steadyCov(six), now: () => E_NOW + RS.PAID_SYNC_CONFIRMATION_TTL_MS + 1000 });
  const r6 = await post(late, { bucket: "non-us", sourceKey: "order-line-items", confirmationToken: tok });
  const key = RS.paidSyncConfirmationKey();
  const v1body = Buffer.from(JSON.stringify({ v: 1, u: m.uid, b: "non-us", s: "order-line-items", m: "normal", t: 999, e: E_NOW + 60_000, n: "abcdefghij" }), "utf8").toString("base64url");
  const { createHmac } = await import("node:crypto");
  const v1 = v1body + "." + createHmac("sha256", key).update(v1body).digest("base64url");
  const r6b = await post(m, { bucket: "non-us", sourceKey: "order-line-items", confirmationToken: v1 });
  ok("E5 a token for another card / bucket / refresh mode / admin, a tampered, EXPIRED or pre-binding (v1) token is refused 428 without a token -- ZERO runtime / audit",
    allRefused && r5.statusCode === 428 && r5.body.reason === "scope-mismatch" && r6.statusCode === 428 && r6.body.reason === "expired"
    && r6b.statusCode === 428 && r6b.body.reason === "version"
    && m.calls.runtimeBuilt === 0 && m.calls.audit === 0 && other.calls.runtimeBuilt === 0 && late.calls.runtimeBuilt === 0);

  // E6 a valid token proceeds (to the preflight sentinel), exactly like the pre-WP10b execute path
  const s6 = paidEnv({ directory: six.map((id) => dirRow(id, "IN", "non-us")), coverage: steadyCov(six), preflightThrows: true });
  const t6 = (await previewOf(s6, { bucket: "non-us", sourceKey: "order-line-items" })).confirmationToken;
  const r7 = await post(s6, { bucket: "non-us", sourceKey: "order-line-items", confirmationToken: t6 });
  ok("E6 WITH the confirmation token the existing execute path runs (runtime built, evidence preflight reached)", s6.calls.runtimeBuilt >= 1 && s6.calls.preflight === 1 && r7.body && r7.body.error === "REACHED_PREFLIGHT");

  // E7 P1: the execute threads the REMAINING approval into the runtime's zero-create gate + returns a continuation token
  const s7 = paidEnv({ directory: six.map((id) => dirRow(id, "IN", "non-us")), coverage: steadyCov(six) });
  const p7 = await previewOf(s7, { bucket: "non-us", sourceKey: "order-line-items" });
  const r8 = await post(s7, { bucket: "non-us", sourceKey: "order-line-items", confirmationToken: p7.confirmationToken });
  const a8 = s7.calls.cardAction[0] || {};
  const c8 = claimsOf(s7, r8.body && r8.body.continuationToken, { bucket: "non-us", sourceKey: "order-line-items" });
  ok("E7 P1: the OLI execute passes approvedTokenCeiling { remainingTokens: approved - persisted debit (6), reserveTokens: the release Catalog (2) } to the runtime, AFTER the audit; the response carries the approval + a continuation token (same nonce / ceiling / expiry)",
    r8.statusCode === 200 && a8.approvedTokenCeiling && a8.approvedTokenCeiling.remainingTokens === 6 && a8.approvedTokenCeiling.reserveTokens === 2 && s7.calls.audit === 1
    && r8.body.approval && r8.body.approval.approvedMaxTokens === 6 && r8.body.approval.debitedTokens === 0
    && c8.ok === true && c8.kind === "cont" && c8.nonce === claimsOf(s7, p7.confirmationToken, { bucket: "non-us", sourceKey: "order-line-items" }).nonce && c8.approvedMaxTokens === 6 && c8.asOf === E_ASOF);
  const s7b = paidEnv({ directory: six.map((id) => dirRow(id, "IN", "non-us")), coverage: steadyCov(six), cardResult: () => ({ stopped: true, approvalRefused: true, stopReason: { code: "PAID_APPROVAL_EXCEEDED", exposureTokens: 10, remainingTokens: 6 } }) });
  const p7b = await previewOf(s7b, { bucket: "non-us", sourceKey: "order-line-items" });
  const r8b = await post(s7b, { bucket: "non-us", sourceKey: "order-line-items", confirmationToken: p7b.confirmationToken });
  ok("E7b a runtime approval refusal (the frozen plan now exceeds the remaining approval; zero creates) -> 409 PAID_SYNC_SCOPE_CHANGED with the fresh estimate and NO token",
    r8b.statusCode === 409 && r8b.body.error === "PAID_SYNC_SCOPE_CHANGED" && r8b.body.refusal.code === "PAID_APPROVAL_EXCEEDED" && r8b.body.preview && r8b.body.preview.confirmationToken === null && !r8b.body.continuationToken);

  // E8 P1: CUMULATIVE debit from the PERSISTED spend of the bound cycle (not a static formula)
  const X = "cyc-x";
  const claimed = (n, source = "order-line-items") => Array.from({ length: n }, (_v, i) => ({ request_hash: source + "-h" + i, source_key: source, fetch_status: "attempted", create_export_count: 1 }));
  const s8 = paidEnv({
    directory: six.map((id) => dirRow(id, "IN", "non-us")), coverage: steadyCov(six),
    heads: { ["non-us|" + E_TODAY]: { id: X, status: "running", supersedes_cycle_id: null } },
    jobs: { [X]: [...claimed(2), { request_hash: "p1", source_key: "order-line-items", fetch_status: "pending", create_export_count: 0 }, { request_hash: "p2", source_key: "order-line-items", fetch_status: "pending", create_export_count: 0 }, { request_hash: "p3", source_key: "order-line-items", fetch_status: "pending", create_export_count: 0 }] },
    budgets: { [X + "|source-sync:order-line-items"]: { max_tokens: 10, spent_tokens: 4 } },
  });
  const p8 = await previewOf(s8, { bucket: "non-us", sourceKey: "order-line-items" });
  s8.st.jobs[X] = [...claimed(3), { request_hash: "p2", source_key: "order-line-items", fetch_status: "pending", create_export_count: 0 }, { request_hash: "p3", source_key: "order-line-items", fetch_status: "pending", create_export_count: 0 }];
  const r9 = await post(s8, { bucket: "non-us", sourceKey: "order-line-items", confirmationToken: p8.confirmationToken });
  const a9 = s8.calls.cardAction[0] || {};
  ok("E8 P1: an ACTIVE cycle is priced from its frozen tranche (max 10 - spent 4 = 6, + release 2 = approved 8, baseline 4 persisted), and a later slice is DEBITED from the PERSISTED creates (one more claimed create = 2 tokens -> remaining 6)",
    oliFam(p8).basis === "frozen-remaining" && oliFam(p8).worstCaseTokens === 6 && p8.approvedMaxTokens === 8 && p8.operation.baselineTokens === 4 && p8.operation.cycleId === X
    && r9.statusCode === 200 && a9.approvedTokenCeiling && a9.approvedTokenCeiling.remainingTokens === 6 && r9.body.approval.debitedTokens === 2
    && claimsOf(s8, r9.body.continuationToken, { bucket: "non-us", sourceKey: "order-line-items" }).cycleId === X);

  // E9 P2: the token is bound to the server as-of (a UTC midnight roll -> 409 + re-preview, zero spend)
  const LATE = Date.UTC(2026, 8, 26, 23, 59, 30);
  const s9 = paidEnv({ directory: six.map((id) => dirRow(id, "IN", "non-us")), coverage: steadyCov(six), now: () => LATE });
  const p9 = await previewOf(s9, { bucket: "non-us", sourceKey: "order-line-items" });
  const s9b = paidEnv({ userId: s9.uid, directory: six.map((id) => dirRow(id, "IN", "non-us")), coverage: steadyCov(six), now: () => LATE + 60_000 });
  const r10 = await post(s9b, { bucket: "non-us", sourceKey: "order-line-items", confirmationToken: p9.confirmationToken });
  ok("E9 P2: a token previewed at 23:59:30Z (as-of 2026-09-25) and executed after the UTC midnight roll (as-of 2026-09-26) -> 409 PAID_SYNC_ASOF_CHANGED, fresh estimate WITHOUT a token, ZERO runtime / audit",
    p9.operation.asOf === "2026-09-25" && r10.statusCode === 409 && r10.body.error === "PAID_SYNC_ASOF_CHANGED" && r10.body.preview && r10.body.preview.operation.asOf === "2026-09-26"
    && r10.body.preview.confirmationToken === null && s9b.calls.runtimeBuilt === 0 && s9b.calls.audit === 0);
  const s9c = paidEnv({ directory: six.map((id) => dirRow(id, "IN", "non-us")), coverage: steadyCov(six), preflightToday: "2026-09-27" });
  const p9c = await previewOf(s9c, { bucket: "non-us", sourceKey: "order-line-items" });
  const r10c = await post(s9c, { bucket: "non-us", sourceKey: "order-line-items", confirmationToken: p9c.confirmationToken });
  ok("E9b P2: the runtime's OWN day (preflight.today) must equal the token-bound day -- a roll between the binding check and the preflight is refused BEFORE the audit and any execution",
    r10c.statusCode === 409 && r10c.body.error === "PAID_SYNC_ASOF_CHANGED" && s9c.calls.audit === 0 && s9c.calls.cardAction.length === 0);

  // E10 P2: bound to ONE operation
  const slotKey = "non-us|" + E_TODAY;
  const base10 = { directory: six.map((id) => dirRow(id, "IN", "non-us")), coverage: steadyCov(six) };
  const s10 = paidEnv(base10);
  const startTok = (await previewOf(s10, { bucket: "non-us", sourceKey: "order-line-items" })).confirmationToken;
  s10.st.heads[slotKey] = { id: "cyc-done", status: "succeeded", supersedes_cycle_id: null };
  const rA = await post(s10, { bucket: "non-us", sourceKey: "order-line-items", confirmationToken: startTok });
  s10.st.heads[slotKey] = { id: "cyc-other", status: "pending", supersedes_cycle_id: "cyc-old", operation_key: "oli-freshness/x" };
  const rB = await post(s10, { bucket: "non-us", sourceKey: "order-line-items", confirmationToken: startTok });
  ok("E10a P2: the operation this confirmation approved has FINISHED (its slot head is terminal) -> 409 PAID_SYNC_OPERATION_FINISHED; another operation now owns the slot -> 409 PAID_SYNC_OPERATION_CHANGED; ZERO runtime / audit",
    rA.statusCode === 409 && rA.body.error === "PAID_SYNC_OPERATION_FINISHED" && rB.statusCode === 409 && rB.body.error === "PAID_SYNC_OPERATION_CHANGED"
    && rA.body.preview.confirmationToken === null && s10.calls.runtimeBuilt === 0 && s10.calls.audit === 0);
  const s10b = paidEnv({ ...base10, heads: { [slotKey]: { id: X, status: "running", supersedes_cycle_id: null } }, jobs: { [X]: [] } });
  const tokX = (await previewOf(s10b, { bucket: "non-us", sourceKey: "order-line-items" })).confirmationToken;
  const rC0 = await post(s10b, { bucket: "non-us", sourceKey: "order-line-items", confirmationToken: tokX });
  const contX = rC0.body.continuationToken;
  s10b.st.heads[slotKey] = { id: X, status: "succeeded", supersedes_cycle_id: null };
  const rC = await post(s10b, { bucket: "non-us", sourceKey: "order-line-items", confirmationToken: contX });
  const rCstart = await post(s10b, { bucket: "non-us", sourceKey: "order-line-items", confirmationToken: tokX });
  s10b.st.heads[slotKey] = { id: "cyc-y", status: "running", supersedes_cycle_id: X, operation_key: "priority-legacy-recovery/non-us/" + E_TODAY };
  s10b.st.jobs["cyc-y"] = claimed(1, "product-catalog");
  const beforeD = s10b.calls.cardAction.length;
  const rD = await post(s10b, { bucket: "non-us", sourceKey: "order-line-items", confirmationToken: contX });
  const aD = s10b.calls.cardAction[beforeD] || {};
  s10b.st.heads[slotKey] = { id: "cyc-z", status: "pending", supersedes_cycle_id: X, operation_key: "oli-freshness/non-us/" + E_TODAY };
  const rE = await post(s10b, { bucket: "non-us", sourceKey: "order-line-items", confirmationToken: contX });
  ok("E10b P2: the continuation token RECORDS the cycle (X); it keeps driving X after X is finalized (release publish slices), while the START token is then refused FINISHED",
    rC0.statusCode === 200 && claimsOf(s10b, contX, { bucket: "non-us", sourceKey: "order-line-items" }).cycleId === X && rC.statusCode === 200
    && rCstart.statusCode === 409 && rCstart.body.error === "PAID_SYNC_OPERATION_FINISHED");
  if (process.env.RRO_DEBUG) out("DEBUG E10c " + rD.statusCode + " " + J(rD.body && rD.body.error) + " " + J(aD.approvedTokenCeiling) + " " + rE.statusCode + " " + J(rE.body && rE.body.error));
  ok("E10c P2: X superseded by the priority release's legacy-recovery attempt Y is the SAME operation (debited X + Y: the Catalog create on Y costs 2 -> remaining 4); an UNRELATED superseding attempt Z is refused CHANGED",
    rD.statusCode === 200 && aD.approvedTokenCeiling && aD.approvedTokenCeiling.remainingTokens === 4 && rE.statusCode === 409 && rE.body.error === "PAID_SYNC_OPERATION_CHANGED");
  const B = RS.paidSyncOperationBinding;
  const cl = (o) => ({ cycleId: "", kind: "start", previewTerminal: false, ...o });
  ok("E10d paidSyncOperationBinding (pure): start/no-cycle -> ok on no head or a fresh base head, FINISHED on a terminal head, CHANGED on a superseding head; start bound to X -> FINISHED once X is terminal unless it was terminal at preview; cont bound to X -> ok on X (any status) or its legacy-recovery child",
    B({ claims: cl({}), head: null }).ok && B({ claims: cl({}), head: { id: "N", status: "pending" } }).boundCycleId === "N"
    && B({ claims: cl({}), head: { id: "N", status: "failed" } }).code === "PAID_SYNC_OPERATION_FINISHED"
    && B({ claims: cl({}), head: { id: "N", status: "running", supersedes_cycle_id: "P" } }).code === "PAID_SYNC_OPERATION_CHANGED"
    && B({ claims: cl({ cycleId: "X" }), head: { id: "X", status: "succeeded" } }).code === "PAID_SYNC_OPERATION_FINISHED"
    && B({ claims: cl({ cycleId: "X", previewTerminal: true }), head: { id: "X", status: "succeeded" } }).ok
    && B({ claims: cl({ cycleId: "X", kind: "cont" }), head: { id: "X", status: "partial" } }).ok
    && J(B({ claims: cl({ cycleId: "X", kind: "cont" }), head: { id: "Y", status: "running", supersedes_cycle_id: "X", operation_key: "priority-legacy-recovery/us/d" } }).cycleIds) === J(["X", "Y"])
    && B({ claims: cl({ cycleId: "X", kind: "cont" }), head: { id: "Z", status: "running" } }).code === "PAID_SYNC_OPERATION_CHANGED");

  // E11 the FBA card preview: the exact plan cost + worst case vs the hard bucket ceiling (P3-3)
  const fba = paidEnv({ directory: [dirRow("F1", "IN", "non-us"), dirRow("F2", "IN", "non-us")], coverage: { F1: STEADY, F2: STEADY } });
  const fp = await previewOf(fba, { bucket: "non-us", sourceKey: "fba-inventory-health" });
  const fe = fp.estimate;
  ok("E11 the FBA card preview is the EXACT fba-plan plan cost (premium, batched, cache-aware; zero creates) + a worst case (unclaimed batches) under the 70-token non-us hard ceiling; operation = the dedicated fba cycle",
    fe.basis === "fba-plan-exact" && fe.accounts === 2 && fe.expectedCreates >= 1 && fe.expectedTokens === fe.expectedCreates * 5 && fe.worstCaseTokens === fe.expectedTokens
    && fe.hardCeilingTokens === 70 && fp.approvedMaxTokens === Math.min(fe.worstCaseTokens, 70) && fp.executable === true && typeof fp.confirmationToken === "string"
    && fp.operation.key === "non-us-fba/" + E_ASOF && fba.calls.runtimeBuilt === 0 && fba.calls.audit === 0);
  const usIds = Array.from({ length: 20 }, (_v, i) => "U" + String(i + 1).padStart(2, "0"));
  const fbaUs = paidEnv({ directory: usIds.map((id) => dirRow(id, "US", "us")), coverage: Object.fromEntries(usIds.map((id) => [id, STEADY])) });
  const fpUs = await previewOf(fbaUs, { bucket: "us", sourceKey: "fba-inventory-health" });
  ok("E11b P3-3: an FBA plan whose EXPECTED cost exceeds the hard bucket ceiling (20 US accounts: Health + AWD > 30) is NOT executable -- typed reason, NO token",
    fpUs.estimate.expectedTokens > 30 && fpUs.executable === false && fpUs.reason === "fba-plan-exceeds-hard-ceiling" && fpUs.confirmationToken === null);
  const sources = src("api/admin/sources.js");
  const fbaExecAt = sources.indexOf("advanceFbaPlanBucket({");
  ok("E12 the FBA execute: ceiling min(bucket, approved); the cost passed is ONLY the not-yet-claimed plan cost and debited + cost > approval refuses BEFORE the operation; the confirmation + binding precede the FBA branch, the runtime and every audit write",
    /const maxTokens = Math\.min\(FBA_BUCKET_TOKEN_CEILING\[bucket\], approvedMaxTokens\);/.test(sources)
    && sources.indexOf("fbaUnclaimedPlanCost(planned.plan, cycleJobs)") > 0 && sources.indexOf("fbaUnclaimedPlanCost(planned.plan, cycleJobs)") < fbaExecAt
    && sources.indexOf("paidDebit.debitedTokens + cost.tokens > approvedMaxTokens") > 0 && sources.indexOf("paidDebit.debitedTokens + cost.tokens > approvedMaxTokens") < fbaExecAt
    && sources.indexOf("const inventoryAsOf = paidCtx.cycleDate;") > 0
    && sources.indexOf("verifyPaidSyncConfirmation(body.confirmationToken") < sources.indexOf("if (onlySourceKey && isFbaOperationSource(onlySourceKey)) {\n        const fbaDeadline")
    && sources.indexOf("await paidSyncDebit({ claims: paidConfirmation") < sources.indexOf('action: "source.sync.missing"')
    && /runReleaseSlice\(\{ bucket, release, controls, readbackLive, outOfTime: deadline\.outOfTime, approvedTokenCeiling: \{ remainingTokens: paidDebit\.remainingTokens \} \}\)/.test(sources)
    && sources.indexOf("paidDebit = await paidSyncDebit({ claims: paidConfirmation, ctx: paidCtx, deps, adsSpentTokens: adsSpentNow });") < sources.indexOf("rel = await runReleaseSlice("));

  // E13 the confirmation token primitive (v2)
  const k2 = Buffer.alloc(32, 7);
  const op = { key: "us/2026-09-26", cycleId: "", baselineTokens: 0 };
  const t = RS.issuePaidSyncConfirmation({ userId: "u", bucket: "us", sourceKey: "order-line-items", refreshMode: "normal", approvedMaxTokens: 4, asOf: "2026-09-25", operation: op, now: 1000, key: k2 });
  const v = RS.verifyPaidSyncConfirmation(t.token, { userId: "u", bucket: "us", sourceKey: "order-line-items", refreshMode: "normal", now: 2000, key: k2 });
  const cont = RS.issuePaidSyncConfirmation({ userId: "u", bucket: "us", sourceKey: "order-line-items", refreshMode: "normal", approvedMaxTokens: 4, asOf: "2026-09-25", operation: { ...op, cycleId: "C1", adsSpentTokens: 2, adsSliceSeq: 1 }, kind: "cont", nonce: v.nonce, issuedAt: v.issuedAt, expiresAtMs: v.expiresAtMs, now: 50_000, key: k2 });
  const vc = RS.verifyPaidSyncConfirmation(cont.token, { userId: "u", bucket: "us", sourceKey: "order-line-items", refreshMode: "normal", now: 60_000, key: k2 });
  ok("E13 the v3 token is HMAC-bound (user, bucket, card, mode, ceiling, expiry, as-of, operation slot + cycle + baseline, kind, Ads spend + Ads slice sequence); a continuation re-issue keeps the nonce / ceiling / expiry and must carry an EXPLICIT Ads slice sequence; it fails closed without a key or without the as-of / operation",
    v.ok && v.approvedMaxTokens === 4 && v.asOf === "2026-09-25" && v.operationKey === "us/2026-09-26" && v.cycleId === "" && v.kind === "start" && v.adsSliceSeq === 0
    && vc.ok && vc.kind === "cont" && vc.cycleId === "C1" && vc.adsSpentTokens === 2 && vc.adsSliceSeq === 1 && vc.nonce === v.nonce && vc.expiresAtMs === v.expiresAtMs
    && RS.issuePaidSyncConfirmation({ userId: "u", bucket: "us", sourceKey: "order-line-items", refreshMode: "normal", approvedMaxTokens: 4, asOf: "2026-09-25", operation: { ...op, cycleId: "C1", adsSpentTokens: 2 }, kind: "cont", nonce: v.nonce, issuedAt: v.issuedAt, expiresAtMs: v.expiresAtMs, key: k2 }) === null
    && RS.verifyPaidSyncConfirmation(t.token, { userId: "u", bucket: "us", sourceKey: "order-line-items", refreshMode: "normal", now: 2000, key: Buffer.alloc(32, 8) }).reason === "bad-signature"
    && RS.issuePaidSyncConfirmation({ userId: "u", bucket: "us", approvedMaxTokens: 4, asOf: "2026-09-25", operation: op, key: null }) === null
    && RS.issuePaidSyncConfirmation({ userId: "u", bucket: "us", approvedMaxTokens: 4, operation: op, key: k2 }) === null
    && RS.issuePaidSyncConfirmation({ userId: "u", bucket: "us", approvedMaxTokens: 4, asOf: "2026-09-25", key: k2 }) === null
    && RS.verifyPaidSyncConfirmation(t.token, { userId: "u", bucket: "us", sourceKey: "order-line-items", key: null }).reason === "unavailable"
    && RS.verifyPaidSyncConfirmation("", { key: k2 }).reason === "missing" && RS.verifyPaidSyncConfirmation("a.b.c", { key: k2 }).reason === "malformed"
    && RS.paidSyncConfirmationKey({}) === null && Buffer.isBuffer(RS.paidSyncConfirmationKey({ PAID_SYNC_CONFIRM_SECRET: "s" })));

  // E14 fail closed without the durable directory / operation state
  const broken = paidEnv({ directory: six.map((id) => dirRow(id, "IN", "non-us")), coverage: steadyCov(six), directoryThrows: true });
  const bp = await previewOf(broken, { bucket: "non-us", sourceKey: "order-line-items" });
  const hs = paidEnv({ directory: six.map((id) => dirRow(id, "IN", "non-us")), coverage: steadyCov(six) });
  const hsTok = (await previewOf(hs, { bucket: "non-us", sourceKey: "order-line-items" })).confirmationToken;
  hs.st.headThrows = true;
  const rHs = await post(hs, { bucket: "non-us", sourceKey: "order-line-items", confirmationToken: hsTok });
  ok("E14 FAIL CLOSED: an unreadable account directory yields NO estimate and NO token; an execute whose operation state cannot be read is 503 PAID_SYNC_OPERATION_UNVERIFIABLE -- ZERO runtime / audit",
    bp.executable === false && bp.confirmationToken === null && bp.estimate.unavailable === "account-directory-read-failed"
    && rHs.statusCode === 503 && rHs.body.error === "PAID_SYNC_OPERATION_UNVERIFIABLE" && hs.calls.runtimeBuilt === 0 && hs.calls.audit === 0);

  // E15 cards with no read-only planner are NOT executable
  const cc = paidEnv({ directory: six.map((id) => dirRow(id, "IN", "non-us")), coverage: steadyCov(six) });
  const pSettle = await previewOf(cc, { bucket: "non-us", sourceKey: "settlements" });
  const pRaw = await previewOf(cc, { bucket: "non-us", sourceKey: "listings-raw" });
  const pTgt = await previewOf(cc, { bucket: "non-us", sourceKey: "ads-targeting-date" });
  ok("E15 a cycle-cache card (settlements / listings-raw: no read-only planner) and a non-orchestrated durable-Ads card are NOT executable -- typed reason, NO token, never a fabricated low estimate",
    pSettle.executable === false && pSettle.reason === "planner-not-read-only" && pSettle.confirmationToken === null && pSettle.estimate.worstCaseTokens === undefined
    && pRaw.executable === false && pRaw.reason === "planner-not-read-only" && pTgt.executable === false && pTgt.reason === "durable-ads-architecture" && pTgt.confirmationToken === null);

  // E16 Campaign Ads: the runner's own region planner + the bisection fallback
  const covWin = { read: "ok", windows: [{ from: "2026-08-01", to: E_ASOF }], status: "succeeded" };
  const staleWin = { read: "ok", windows: [{ from: "2026-07-01", to: "2026-08-01" }], status: "succeeded" };
  const adsIds = ["A1", "A2", "A3", "A4", "A5", "A6", "A7"];
  const adsEnv = () => paidEnv({ directory: adsIds.map((id) => dirRow(id, "IN", "non-us")), adsCoverage: { A1: covWin, A2: covWin, A3: staleWin, A4: staleWin, A5: staleWin } });
  const ae = adsEnv();
  const pa = await previewOf(ae, { bucket: "non-us", sourceKey: "ads-campaign-date" });
  ok("E16 the Campaign Ads preview runs planCampaignAdsRegionRun over durable coverage (2 covered, 3 rolling-pending -> 1 batch, 2 never-covered -> 1 initial batch): expected 2 creates (4) + release 2 = 6; worst adds the bisection fallback (5 pending sellers): (2 + 5) x 2 + 2 = 16 -- ZERO DataDoe",
    pa.estimate.basis === "campaign-ads-planner" && pa.estimate.families[0].expectedCreates === 2 && pa.estimate.families[0].bisectionFallbackCreates === 5
    && pa.estimate.expectedTokens === 6 && pa.estimate.worstCaseTokens === 16 && pa.approvedMaxTokens === 16 && typeof pa.confirmationToken === "string" && ae.calls.runtimeBuilt === 0);
  // E17 the Ads execute derives the create caps from the REMAINING approval; the Ads spend is carried in the token
  const ra = await post(ae, { bucket: "non-us", sourceKey: "ads-campaign-date", confirmationToken: pa.confirmationToken });
  const aa = ae.calls.ads[0] || {};
  const ca = claimsOf(ae, ra.body && ra.body.continuationToken, { bucket: "non-us", sourceKey: "ads-campaign-date" });
  const ra2 = await post(ae, { bucket: "non-us", sourceKey: "ads-campaign-date", confirmationToken: ra.body.continuationToken });
  const aa2 = ae.calls.ads[1] || {};
  const ca2 = claimsOf(ae, ra2.body && ra2.body.continuationToken, { bucket: "non-us", sourceKey: "ads-campaign-date" });
  ok("E17 P1: the Ads execute passes maxCreates / maxFallbackCreates / maxTotalCreates = floor((approved 16 - debited 0 - release reserve 2) / 2) = 7; the slice's 4 tokens are carried in the signed continuation token (Ads step 1), so the next slice's cap is floor((16 - 4 - 2) / 2) = 5; each response's approval is POST-slice (P3-3: debited 4, then 8)",
    ra.statusCode === 200 && aa.maxCreates === 7 && aa.maxFallbackCreates === 7 && aa.maxTotalCreates === 7 && aa.asOf === E_ASOF
    && ca.ok && ca.adsSpentTokens === 4 && ca.adsSliceSeq === 1 && ra.body.approval.debitedTokens === 4 && ra.body.approval.remainingTokens === 12
    && ra2.statusCode === 200 && aa2.maxTotalCreates === 5 && ra2.body.approval.debitedTokens === 8 && ca2.ok && ca2.adsSliceSeq === 2 && ca2.adsSpentTokens === 8
    && ae.st.receipts.size === 2);
  // E17c (WP10b re-verify P1): every Ads step is SINGLE-USE -- replaying the start token (or the step-1 token) after it was
  // used is refused 409 PAID_SYNC_TOKEN_CONSUMED with ZERO runner calls (the full matrix lives in admin-sources-boundary).
  const adsCallsBefore = ae.calls.ads.length;
  const replayStart = await post(ae, { bucket: "non-us", sourceKey: "ads-campaign-date", confirmationToken: pa.confirmationToken });
  const replayStep1 = await post(ae, { bucket: "non-us", sourceKey: "ads-campaign-date", confirmationToken: ra.body.continuationToken });
  ok("E17c P1: a replayed start / older continuation token for Campaign Ads -> 409 PAID_SYNC_TOKEN_CONSUMED (fresh estimate, no token), ZERO runner calls",
    replayStart.statusCode === 409 && replayStart.body.error === "PAID_SYNC_TOKEN_CONSUMED" && replayStart.body.preview.confirmationToken === null
    && replayStep1.statusCode === 409 && replayStep1.body.error === "PAID_SYNC_TOKEN_CONSUMED" && ae.calls.ads.length === adsCallsBefore);
  const ar = paidEnv({ directory: adsIds.map((id) => dirRow(id, "IN", "non-us")), adsResult: (a) => ({ phase: "sync", ok: false, refused: true, code: "CAMPAIGN_ADS_APPROVAL_EXCEEDED", plannedCreates: 9, maxTotalCreates: a.maxTotalCreates, creates: 0, tokens: 0 }) });
  const par = await previewOf(ar, { bucket: "non-us", sourceKey: "ads-campaign-date" });
  const rar = await post(ar, { bucket: "non-us", sourceKey: "ads-campaign-date", confirmationToken: par.confirmationToken });
  ok("E17b an Ads plan that now needs more creates than the approval covers is refused by the runner with ZERO creates -> 409 PAID_SYNC_SCOPE_CHANGED (fresh estimate, no token)",
    rar.statusCode === 409 && rar.body.error === "PAID_SYNC_SCOPE_CHANGED" && rar.body.preview.confirmationToken === null);
  // E18 the whole bucket (no card): the planner over every durable family + the same gate, no release reserve
  const wb = paidEnv({ directory: six.map((id) => dirRow(id, "IN", "non-us")), coverage: steadyCov(six) });
  const pw = await previewOf(wb, { bucket: "non-us" });
  const rw = await post(wb, { bucket: "non-us", confirmationToken: pw.confirmationToken });
  const aw = wb.calls.run[0] || {};
  ok("E18 the whole-bucket sync (no card) is priced by the same planner (OLI + stale FBA snapshots, premium) with no release reserve, and runs with approvedTokenCeiling { remainingTokens: approved, reserveTokens: 0 }",
    pw.executable === true && !pw.estimate.release && pw.estimate.families.some((f) => f.sourceKey === "fba-inventory-health" && f.tokensPerExport === 5)
    && rw.statusCode === 200 && aw.approvedTokenCeiling && aw.approvedTokenCeiling.remainingTokens === pw.approvedMaxTokens && aw.approvedTokenCeiling.reserveTokens === 0);
  ok("E19 the estimator's persisted-spend ledger prices create_export_count by the registry (standard 2 / premium 5 / unknown 5) and ignores unclaimed jobs",
    EST.persistedCycleSpend([{ source_key: "order-line-items", create_export_count: 1 }, { source_key: "fba-inventory-health", create_export_count: 1 }, { source_key: "order-line-items", create_export_count: 0 }, { source_key: "mystery", create_export_count: 1 }]).tokens === 12);
})();

// =====================================================================================================================
// F. Scheduler v1 refuses route-owned keys
// =====================================================================================================================
await (async () => {
  const mk = (settings = []) => {
    const calls = { audit: 0, run: [], setting: 0 };
    return {
      calls,
      deps: {
        getDashboardAccess: async () => ({ userId: "admin1", role: "admin" }), assertAdmin: () => {},
        insertAuditLog: async () => { calls.audit += 1; },
        setReportSyncSetting: async () => { calls.setting += 1; }, setSourcePromotedPublishControl: async () => {},
        getReportSyncSettings: async () => settings, getSourcePromotedPublishSettings: async () => [], getSyncTargets: async () => [], getAccountDirectoryRows: async () => [],
        runScheduledSync: async (o) => { calls.run.push(o); return { bucket: o.bucket, drained: true, skipped: "all-reports-paused" }; },
        isSupabaseConfigured: () => true, verifyCronRequest: () => true,
      },
    };
  };
  let adminAll = true;
  for (const key of ["brand-sales", "daily-reporting", "fba-plan", "returns-leakage"]) {
    const t = mk();
    const r = fakeRes();
    await ADMIN_SYNC.handler({ method: "POST", body: { reportKey: key, bucket: "us" } }, r, t.deps);
    if (!(r.statusCode === 409 && r.body.code === RS.ROUTE_OWNED_REPORT_V1_REFUSED && J(r.body.refusedReportKeys) === J([key]) && r.body.paidSync[key] && t.calls.audit === 0 && t.calls.run.length === 0)) adminAll = false;
  }
  ok("F1 api/admin/sync.js POST (manual v1 run) of EVERY controlled route-owned key -> typed 409 ROUTE_OWNED_REPORT_V1_REFUSED + paidSync; ZERO audit / dispatch", adminAll);
  const t2 = mk();
  const r2 = fakeRes();
  await ADMIN_SYNC.handler({ method: "POST", body: { reportKey: "reconciliation", bucket: "us" } }, r2, t2.deps);
  ok("F2 a NON-route-owned controlled key keeps its existing behaviour (reconciliation: the v1 'locked until verified' 409, not the route-owned refusal)",
    r2.statusCode === 409 && /locked until its Scheduler v2 adapter/.test(r2.body.error) && r2.body.code !== RS.ROUTE_OWNED_REPORT_V1_REFUSED && t2.calls.run.length === 0);
  const t3 = mk();
  const r3 = fakeRes();
  await ADMIN_SYNC.handler({ method: "PATCH", body: { reportKey: "brand-sales", scheduleEnabled: false } }, r3, t3.deps);
  ok("F3 the schedule control (PATCH, a control write, not a report write) is unchanged for a route-owned key", r3.statusCode === 200 && t3.calls.setting === 1 && t3.calls.audit === 1);

  const enabled = [{ report_key: "brand-sales", schedule_enabled: true }];
  const t4 = mk(enabled);
  const r4 = fakeRes();
  await V1_SYNC.handler({ method: "POST", body: { bucket: "us" }, headers: {} }, r4, t4.deps);
  const t5 = mk(enabled);
  const r5 = fakeRes();
  await CRON_SYNC.handler({ method: "GET", query: { bucket: "us" }, headers: {} }, r5, t5.deps);
  ok("F4 api/sync.js POST and api/cron/sync.js refuse a schedule that would dispatch ONLY route-owned keys: typed 409, ZERO audit / dispatch",
    r4.statusCode === 409 && r4.body.code === RS.ROUTE_OWNED_REPORT_V1_REFUSED && t4.calls.audit === 0 && t4.calls.run.length === 0
    && r5.statusCode === 409 && r5.body.code === RS.ROUTE_OWNED_REPORT_V1_REFUSED && r5.body.paidSync["brand-sales"].available === false && t5.calls.run.length === 0);
  const t6 = mk([]);
  const r6 = fakeRes();
  await V1_SYNC.handler({ method: "POST", body: { bucket: "us" }, headers: {} }, r6, t6.deps);
  const t7 = mk([]);
  const r7 = fakeRes();
  await CRON_SYNC.handler({ method: "GET", query: { bucket: "non-us" }, headers: {} }, r7, t7.deps);
  ok("F5 with nothing route-owned scheduled the v1 runs proceed as before, but ALWAYS with an explicit allow-list (never null -> never a later re-read)",
    r6.statusCode === 200 && t6.calls.run.length === 1 && J(t6.calls.run[0].reportKeys) === J([]) && t6.calls.audit === 1
    && r7.statusCode === 200 && t7.calls.run.length === 1 && J(t7.calls.run[0].reportKeys) === J([]));
  const split = RS.splitSchedulerV1ReportKeys(["brand-sales", "sales-movers", "fba-plan", "reconciliation", "sales-movers"]);
  ok("F6 the v1 allow-list keeps every NON-route-owned key (manual-paid) and drops every route-owned one",
    J(split.allowed) === J(["sales-movers", "reconciliation"]) && J(split.refused) === J(["brand-sales", "fba-plan"]));
})();

// =====================================================================================================================
// G. frontend wiring + the Vercel function cap
// =====================================================================================================================
{
  const bv = src("src/views/BrandView.jsx");
  const bp = src("src/views/BrandPortfolio.jsx");
  const dsc = src("src/views/DataSyncCenter.jsx");
  const app = src("src/App.jsx");
  const shell = src("src/components/shell.jsx");
  ok("G1 Brand View + Brand Portfolio: the Refresh buttons are 'Reload saved data'; admins additionally get 'Request paid sync (uses DataDoe tokens)' (navigation only)",
    [bv, bp].every((s) => /Reload saved data/.test(s) && /Request paid sync \(uses DataDoe tokens\)/.test(s) && /onRequestPaidSync/.test(s)) && !/Build from saved data/.test(bv + bp) && !/Rebuild from saved data/.test(bv + bp));
  ok("G2 the former admin 'Fetch latest data' (which re-ran the now read-only brand-sales / brand-inventory refresh=1) is gone from Brand Portfolio",
    !/Fetch latest data|refreshBrandSourceAccounts|onFetchLatestData/.test(bp.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
  ok("G3 App wires the paid-sync entry for ADMINS only (onRequestPaidSync={isAdmin ? openPaidSync : null}; header paidSync only when isAdmin) to the Data Sync Center",
    (app.match(/onRequestPaidSync=\{isAdmin \? openPaidSync : null\}/g) || []).length === 2 && /const openPaidSync = \(\) => \{ setView\("sync-center"\);/.test(app)
    && /paidSync: isAdmin && routeOwnedView && !onFeed/.test(app) && /refresh\.paidSync && \(/.test(shell));
  ok("G4 the Data Sync Center asks for the zero-spend preview, shows the estimate (expected / worst case / approved ceiling) in an explicit confirm, then presents the confirmation token -- and each slice's continuationToken -- on EVERY poll",
    /preview: true/.test(dsc) && /window\.confirm\(paidEstimateText\(card, startedBucket, preview\)\)/.test(dsc) && /let confirmationToken = preview\.confirmationToken;/.test(dsc)
    && /body: JSON\.stringify\(\{ bucket: startedBucket, sourceKey: card\.sourceKey, confirmationToken \}\)/.test(dsc) && /if \(response\.continuationToken\) confirmationToken = response\.continuationToken;/.test(dsc)
    && /Worst case: \$\{est\.worstCaseCreates/.test(dsc) && /Approved hard ceiling: \$\{preview\.approvedMaxTokens\}/.test(dsc)
    && dsc.indexOf("preview: true") < dsc.indexOf("window.confirm(paidEstimateText(card, startedBucket, preview))") && dsc.indexOf("window.confirm(paidEstimateText(card, startedBucket, preview))") < dsc.indexOf("let confirmationToken = preview.confirmationToken;"));
  ok("G4b P3-1: the DSC shows the server's body.message, and on a 409 scope / as-of / operation change or a 428 it shows the reason + the attached fresh estimate and asks AGAIN -- a new token only via a NEW preview (never auto-approved)",
    /const text = body\.message \? \(body\.error \? `\$\{body\.error\}: \$\{body\.message\}` : body\.message\) : \(body\.error \|\| `Request failed/.test(dsc)
    && /error\.status = response\.status;/.test(dsc) && /error\.body = body;/.test(dsc)
    && /\(err\.status === 409 \|\| err\.status === 428\) && PAID_RECONFIRM_CODES\.has\(err\.code\)/.test(dsc)
    && ["PAID_SYNC_SCOPE_CHANGED", "PAID_SYNC_ASOF_CHANGED", "PAID_SYNC_OPERATION_FINISHED", "PAID_SYNC_CONFIRMATION_REQUIRED", "PAID_SYNC_TOKEN_CONSUMED"].every((c) => dsc.includes('"' + c + '"'))
    && /const fresh = await requestPreview\(\);/.test(dsc) && /confirmationToken = fresh\.confirmationToken;/.test(dsc)
    && dsc.indexOf("const ask = window.confirm(") < dsc.indexOf("const fresh = await requestPreview();"));
  const listApi = (dir = path.join(ROOT, "api"), prefix = "") => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? listApi(path.join(dir, e.name), prefix + e.name + "/") : (e.name.endsWith(".js") ? [prefix + e.name] : []))).sort();
  ok("G5 no new api/*.js function (the Vercel 12-function cap): still exactly the 12 known entries",
    J(listApi()) === J(["access.js", "admin/sources.js", "admin/sync.js", "campaign-brand-mapping.js", "cron/[scope].js", "cron/sync.js", "datadoe.js", "fba-plan-columns.js", "fba-plan-config.js", "sku-movement-identifier.js", "sku-movement-prefs.js", "sync.js"]));
}

// =====================================================================================================================
// H. the runtime approval gates (the OPTIONAL parameters the Data Sync Center threads; absent => unchanged)
// =====================================================================================================================
// A compact in-memory scheduler-v2 store (the same contract the source-bucket-sync suite models: canonical jobs + owners,
// the frozen tranche budget + ATOMIC pre-POST reservation, head-aware cycles, strict-continuation readers).
function memStore() {
  const cycles = new Map(); const jobs = new Map(); const owners = new Map(); const cache = new Map(); const budgets = new Map(); let seq = 0;
  const counters = { reserves: 0, persistBudget: 0, openCycle: 0 };
  const find = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const bk = (c, t) => c + "|" + t;
  return {
    counters, _cycles: cycles, _jobs: jobs, _budgets: budgets,
    openCycle({ bucket, cycleDate }) { counters.openCycle += 1; const k = bucket + "|" + cycleDate; if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, status: "pending" }); jobs.set(id, new Map()); } return cycles.get(k).id; },
    claimCycle(id) { const c = find(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return find(id); },
    upsertSourceJob(j) { const m = jobs.get(j.cycleId); if (m.has(j.requestHash)) return; m.set(j.requestHash, { request_hash: j.requestHash, request_key: j.requestKey, source_id: j.sourceId, source_key: j.sourceKey, connection_id: j.connectionId, organization_fingerprint: j.organizationFingerprint, account_scope_hash: j.accountScopeHash, fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, terminal: false, error_code: null, row_count: null }); },
    listSourceJobs(id) { return [...((jobs.get(id) && jobs.get(id).values()) || [])].map((j) => ({ ...j })); },
    upsertSourceJobOwners(ms) { for (const m of ms || []) { if (!owners.has(m.cycleId)) owners.set(m.cycleId, new Map()); owners.get(m.cycleId).set(m.ownerId + "|" + m.requestHash, { request_hash: m.requestHash, owner_id: m.ownerId, request_key: m.requestKey, report_key: m.reportKey, account_id: m.accountId, owner_status: "active" }); } },
    listSourceJobOwners(cid, ids) { const s = new Set(ids || []); return [...((owners.get(cid) && owners.get(cid).values()) || [])].filter((m) => s.has(m.owner_id)).map((m) => ({ ...m })); },
    recordSourceOwnerStale() {},
    claimExportAttempt(id, h) { const j = jobs.get(id).get(h); if (j && j.fetch_status === "pending" && !j.attempted_at) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; } return false; },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobs.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) { const e = cache.get(h); return e ? { ...e } : null; },
    saveSourceRows({ job, rows, payloadBytes }) { const h = job.requestHash; const p = "source-cache/" + h + ".json"; cache.set(h, { rows: [...rows], source_id: job.sourceId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash, object_path: p, row_count: rows.length, payload_bytes: payloadBytes }); return p; },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount }) { Object.assign(jobs.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount }); },
    recordSourceFailure({ cycleId, requestHash, code, terminal }) { Object.assign(jobs.get(cycleId).get(requestHash), { fetch_status: "failed", error_code: code, terminal: !!terminal }); },
    updateCycleCounts() {},
    persistBudget({ cycleId, trancheKey, planFingerprint, maxCreates, maxTokens, hashes }) { counters.persistBudget += 1; const k = bk(cycleId, trancheKey); if (budgets.has(k)) return "exists"; budgets.set(k, { planFingerprint, maxCreates, maxTokens, spentCreates: 0, spentTokens: 0, cost: new Map((hashes || []).map((h) => [h.requestHash, h.tokenCost])) }); return "created"; },
    reserveExportCreate({ cycleId, trancheKey, requestHash, planFingerprint }) {
      counters.reserves += 1;
      const b = budgets.get(bk(cycleId, trancheKey));
      if (!b || b.planFingerprint !== planFingerprint || !b.cost.has(requestHash)) return "plan-mismatch";
      const c = b.cost.get(requestHash);
      if (b.spentCreates + 1 > b.maxCreates || b.spentTokens + c > b.maxTokens) return "budget-exceeded";
      const j = jobs.get(cycleId).get(requestHash);
      if (!(j && j.fetch_status === "pending" && !j.attempted_at && j.create_export_count === 0)) return "not-pending";
      j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; b.spentCreates += 1; b.spentTokens += c;
      return "reserved";
    },
    getCycleByBucketDate(bucket, cycleDate) { const c = cycles.get(bucket + "|" + cycleDate); return c ? { id: c.id, bucket: c.bucket, status: c.status } : null; },
    getBudget({ cycleId, trancheKey }) { const b = budgets.get(bk(cycleId, trancheKey)); return b ? { plan_fingerprint: b.planFingerprint, max_creates: b.maxCreates, max_tokens: b.maxTokens, spent_creates: b.spentCreates, spent_tokens: b.spentTokens } : null; },
    getBudgetHashes({ cycleId, trancheKey }) { const b = budgets.get(bk(cycleId, trancheKey)); return b ? [...b.cost.entries()].map(([request_hash, token_cost]) => ({ request_hash, token_cost })) : []; },
    listCycleOwners(cid) { return [...((owners.get(cid) && owners.get(cid).values()) || [])].map((m) => ({ ...m })); },
  };
}
// A DataDoe spy: counts creates; OLI rows are valid canonical fragment rows for the requested sellers.
function ddSpy(clockRef = null) {
  const creates = [];
  return {
    creates,
    async create(job) { creates.push(job.requestHash); if (clockRef) clockRef.now += clockRef.jump; return { exportId: "e_" + job.requestHash }; },
    async poll() {},
    async download(job) {
      const fp = job.fetchParams || {};
      return (fp.sellerOrVendorIds || []).map((sid) => ({ date: fp.to, seller_or_vendor_id: sid, sku: "SKU-A", child_asin: "B0A", item_price_currency: "USD", amazon_order_status: "Shipped", fulfillment_channel: "AFN", address_state: "CA", address_city: "LA", total_sales_sum: 100, total_units_sum: 10 }));
    },
  };
}
await (async () => {
  const SBS = await import("../lib/server/sync/source-bucket-sync.js");
  const RT = await import("../lib/server/sync/source-bucket-sync-runtime.js");
  const ADS = await import("../lib/server/sync/scheduled-campaign-ads-runner.js");
  const H_ASOF = "2026-08-15"; const H_TODAY = "2026-08-15"; const H_CYCLE = "2026-08-20";
  const accts = (n) => Array.from({ length: n }, (_v, i) => ({ accountId: "A" + String(i + 1).padStart(2, "0"), rawSellerId: "S" + String(i + 1).padStart(2, "0"), country: "US" }));
  const TEN = accts(10); // two stable <=5-seller batches -> two steady-state OLI exports (2 tokens each) = frozen OLI max 4
  const steady = Object.fromEntries(TEN.map((a) => [a.accountId, [{ from: "2025-01-01", to: "2026-08-07" }]]));
  const onlyOli = new Set(REG.SOURCE_REGISTRY.map((e) => e.sourceKey).filter((k) => k !== "order-line-items"));
  const runArgs = (store, dataDoe, extra = {}) => ({
    apiKey: "prim-key", bucket: "us", accounts: TEN, coverageByAccountId: steady, pausedSources: onlyOli, asOf: H_ASOF, today: H_TODAY,
    store, dataDoe, cycleDate: H_CYCLE, cooldownMs: 0, catalogCarrierSeller: "A01", ...extra,
  });
  const runStatus = [];
  const trackRunStatus = async (e) => { runStatus.push(e); };

  // H1: a frozen plan whose cost exceeds the approval -> typed refusal, ZERO creates / cycles / budgets / reservations / run-status
  {
    const store = memStore(); const dd = ddSpy(); runStatus.length = 0;
    const r = await SBS.runBucketSourceSync(runArgs(store, dd, { updateRunStatus: trackRunStatus, approvedTokenCeiling: { remainingTokens: 5, reserveTokens: 2 } }));
    ok("H1 runBucketSourceSync: a FRESH frozen plan (OLI 4) + the release reserve (2) over the remaining approval (5) is refused typed PAID_APPROVAL_EXCEEDED with ZERO creates, cycles, budgets, reservations and run-status writes",
      r.stopped === true && r.approvalRefused === true && r.stopReason.code === "PAID_APPROVAL_EXCEEDED" && r.stopReason.exposureTokens === 4 && r.stopReason.reserveTokens === 2 && r.stopReason.remainingTokens === 5
      && r.continuationRequired === false && dd.creates.length === 0 && store.counters.openCycle === 0 && store.counters.persistBudget === 0 && store.counters.reserves === 0 && runStatus.length === 0);
    const mal = await SBS.runBucketSourceSync(runArgs(memStore(), ddSpy(), { approvedTokenCeiling: { remainingTokens: "lots" } }));
    ok("H1b a MALFORMED approval fails closed (typed refusal, zero creates)", mal.approvalRefused === true && mal.stopReason.reason === "approval-malformed");
  }
  // H2: an admitted plan behaves EXACTLY like the ungated run (absent parameter == the scheduler path)
  {
    const sA = memStore(); const dA = ddSpy();
    const plain = await SBS.runBucketSourceSync(runArgs(sA, dA));
    const sB = memStore(); const dB = ddSpy();
    const gated = await SBS.runBucketSourceSync(runArgs(sB, dB, { approvedTokenCeiling: { remainingTokens: 6, reserveTokens: 2 } }));
    const { approvedExposure, ...gatedRest } = gated;
    ok("H2 an ADMITTED approval (exposure 4 + reserve 2 <= 6) runs EXACTLY the ungated plan: same rollup, same creates, same frozen budget, same job states (+ only the approvedExposure observability field)",
      J(gatedRest) === J(plain) && J(dA.creates) === J(dB.creates) && dB.creates.length === 2 && approvedExposure && approvedExposure.exposureTokens === 4
      && J([...sA._budgets.values()].map((b) => [b.maxTokens, b.spentTokens])) === J([...sB._budgets.values()].map((b) => [b.maxTokens, b.spentTokens]))
      && J([...sA._jobs.values()].map((m) => [...m.values()].map((j) => j.fetch_status))) === J([...sB._jobs.values()].map((m) => [...m.values()].map((j) => j.fetch_status))));
  }
  // H3: a continuation that would cross the approval stops BEFORE the crossing create
  {
    const clock = { now: Date.UTC(2026, 7, 20, 3, 0), jump: 10 * 60_000 };
    const store = memStore(); const dd = ddSpy(clock);
    const slice1 = await SBS.runBucketSourceSync(runArgs(store, dd, { clock: () => clock.now, deadlineMs: clock.now + 60_000, reserveMs: 1000, approvedTokenCeiling: { remainingTokens: 4, reserveTokens: 0 } }));
    const cyc = [...store._cycles.values()][0];
    const budget = store.getBudget({ cycleId: cyc && cyc.id, trancheKey: "source-sync:order-line-items" });
    // Between slices another create was debited to this operation (persisted spend 2 of the frozen 4 + 1 elsewhere):
    // the approval still unspent is 1 < the frozen remaining exposure 2 -> the slice must create NOTHING.
    const createsBefore = dd.creates.length; const reservesBefore = store.counters.reserves;
    const clock2 = { now: clock.now, jump: 0 };
    const slice2 = await SBS.runBucketSourceSync(runArgs(store, ddSpy(clock2), { clock: () => clock2.now, deadlineMs: Infinity, approvedTokenCeiling: { remainingTokens: 1, reserveTokens: 0 } }));
    ok("H3 a CONTINUATION (frozen OLI max 4, persisted spend 2 after slice 1) whose remaining frozen exposure (2) exceeds the approval still unspent (1) stops BEFORE the crossing create: typed refusal, ZERO new creates / reservations",
      slice1.continuationRequired === true && dd.creates.length === 1 && budget && budget.max_tokens === 4 && budget.spent_tokens === 2
      && slice2.approvalRefused === true && slice2.stopReason.byFamily[0].basis === "frozen-remaining" && slice2.stopReason.exposureTokens === 2
      && dd.creates.length === createsBefore && store.counters.reserves === reservesBefore);
    const dd3 = ddSpy();
    const slice3 = await SBS.runBucketSourceSync(runArgs(store, dd3, { clock: () => clock2.now, deadlineMs: Infinity, approvedTokenCeiling: { remainingTokens: 2, reserveTokens: 0 } }));
    ok("H3b ... and with exactly the remaining exposure approved the continuation completes the ONE frozen create left (total spend 4 = the approval), never more",
      !slice3.approvalRefused && dd3.creates.length === 1 && store.getBudget({ cycleId: cyc.id, trancheKey: "source-sync:order-line-items" }).spent_tokens === 4);
  }
  // H4: runSourceCardAction refuses a cycle-cache family under an approval BEFORE any I/O; absent -> unchanged routing
  {
    const boom = () => { throw new Error("NO_IO_EXPECTED"); };
    const rt = RT.buildBucketSourceSyncRuntime({ readSourceControls: boom, getConnections: boom, fetchAccounts: boom, readCoverage: boom, readSnapshot: boom });
    const r = await rt.runSourceCardAction({ bucket: "us", sourceKey: "settlements", approvedTokenCeiling: { remainingTokens: 100, reserveTokens: 0 } });
    const rAds = await rt.runSourceCardAction({ bucket: "us", sourceKey: "ads-targeting-date", approvedTokenCeiling: { remainingTokens: 100, reserveTokens: 0 } });
    const rtSrc = src("lib/server/sync/source-bucket-sync-runtime.js");
    ok("H4 runSourceCardAction: a cycle-cache family under an owner approval is refused typed PAID_APPROVAL_UNSUPPORTED_ARCHITECTURE BEFORE any read / DataDoe (no read-only planner can bound it); durable-Ads keeps its own typed refusal; the durable families thread the approval into run() -> runBucketSourceSync only when supplied",
      r.refused === true && r.code === "PAID_APPROVAL_UNSUPPORTED_ARCHITECTURE" && rAds.refused === true && rAds.code === "SOURCE_ACTION_ADS_ARCHITECTURE"
      && (rtSrc.match(/\.\.\.approvalArg \}\);/g) || []).length === 2 && /\.\.\.\(approvedTokenCeiling != null \? \{ approvedTokenCeiling \} : \{\}\),/.test(rtSrc));
  }
  // H5: runReleaseSlice gates the release's ONE possible create (the date's Catalog export)
  {
    const mkRelease = (reservation, calls) => ({
      deriveBucket: async () => { calls.derive += 1; return { rollup: { stopped: true, stopReason: { code: "SENTINEL" } } }; },
      catalogReservation: async () => { calls.reservation += 1; if (reservation instanceof Error) throw reservation; return reservation; },
      finalizeBucket: async () => ({}), preflightAccount: async () => ({}), publishAccount: async () => ({}),
    });
    const controls = { apply: async () => {}, close: async () => {} };
    const readback = async () => ({ ok: true });
    const c1 = { derive: 0, reservation: 0 };
    const r1 = await OPS.runReleaseSlice({ bucket: "us", release: mkRelease(null, c1), controls, readbackLive: readback, approvedTokenCeiling: { remainingTokens: 1 } });
    const c2 = { derive: 0, reservation: 0 };
    const r2 = await OPS.runReleaseSlice({ bucket: "us", release: mkRelease(null, c2), controls, readbackLive: readback, approvedTokenCeiling: { remainingTokens: 2 } });
    const c3 = { derive: 0, reservation: 0 };
    const r3 = await OPS.runReleaseSlice({ bucket: "us", release: mkRelease({ exportId: "e1", tokensSpent: 2, status: "created" }, c3), controls, readbackLive: readback, approvedTokenCeiling: { remainingTokens: 0 } });
    const c4 = { derive: 0, reservation: 0 };
    const r4 = await OPS.runReleaseSlice({ bucket: "us", release: mkRelease(new Error("read blip"), c4), controls, readbackLive: readback, approvedTokenCeiling: { remainingTokens: 10 } });
    const c5 = { derive: 0, reservation: 0 };
    await OPS.runReleaseSlice({ bucket: "us", release: mkRelease(null, c5), controls, readbackLive: readback });
    ok("H5 runReleaseSlice: an unreserved release Catalog (2 tokens) over the remaining approval (1) is refused typed BEFORE the derive (zero creates); 2 approved -> the derive runs; an existing reservation costs 0 (runs even at 0 remaining); an unreadable reservation fails closed; ABSENT -> the reservation is not even read before the derive (unchanged)",
      r1.phase === "approval" && r1.code === "PAID_APPROVAL_EXCEEDED" && r1.exposureTokens === 2 && c1.derive === 0
      && c2.derive === 1 && r2.phase === "derive" && c3.derive === 1 && r3.phase === "derive"
      && r4.code === "PAID_APPROVAL_UNVERIFIABLE" && c4.derive === 0 && c5.reservation === 0 && c5.derive === 1);
  }
  // H6: Campaign Ads -- bisection capped BEFORE the POST; an over-cap plan is refused with zero creates; absent -> unchanged
  {
    const adsDeps = (created, extra = {}) => ({
      getConnections: () => [{ id: "primary", apiKey: "k" }],
      fetchAccounts: async () => ["C1", "C2", "C3", "C4", "C5"].map((id) => ({ id, accountId: id, country: "IN" })),
      fetchCompatibleSourceNames: async () => new Set([ADS.CAMPAIGN_ADS_SOURCE_NAME]),
      getCoverage: async () => ({ read: "ok", windows: [{ from: "2026-07-01", to: "2026-07-02" }], status: "succeeded" }),
      createExport: async () => { created.push(1); return { exportId: "x" }; },
      // A worker whose every create is a create-time 400 on the batch -> the recovery engine bisects it.
      runAdsSyncWithDeps: async (workerDeps) => { await workerDeps.createExport(); throw Object.assign(new Error("rejected"), { httpStatus: 400 }); },
      ...extra,
    });
    const capped = [];
    const rc = await ADS.runCampaignAdsBucketSlice({ bucket: "non-us", asOf: "2026-09-25", maxCreates: 3, maxFallbackCreates: 3, maxTotalCreates: 3, deps: adsDeps(capped) });
    const uncapped = [];
    const ru = await ADS.runCampaignAdsBucketSlice({ bucket: "non-us", asOf: "2026-09-25", deps: adsDeps(uncapped) });
    const refused = [];
    let workerRan = 0;
    const rr = await ADS.runCampaignAdsBucketSlice({ bucket: "non-us", asOf: "2026-09-25", maxTotalCreates: 0, deps: adsDeps(refused, { runAdsSyncWithDeps: async () => { workerRan += 1; return {}; } }) });
    ok("H6 Campaign Ads: a rejecting 5-seller batch bisects, but the approved total cap (3) stops the split creates BEFORE the POST (exactly 3 creates, 6 tokens); without the cap the runner's own ceilings apply (more creates); a plan needing more normal creates than the cap is refused with ZERO creates (the worker never runs)",
      capped.length === 3 && rc.creates === 3 && rc.tokens === 6 && uncapped.length > 3 && ru.creates === uncapped.length
      && rr.refused === true && rr.code === "CAMPAIGN_ADS_APPROVAL_EXCEEDED" && rr.creates === 0 && refused.length === 0 && workerRan === 0);
    ok("H6b campaignAdsPlanExposure mirrors the runner's batching (rolling vs initial batches) and its default fallback ceiling (the pending seller count)",
      J(ADS.campaignAdsPlanExposure({ compatible: [1], pending: accts(6), initialPending: accts(2) })) === J({ normalCreates: 3, fallbackCreates: 8, pendingAccounts: 8 })
      && ADS.campaignAdsPlanExposure({ compatible: [], pending: accts(3), initialPending: [] }).normalCreates === 0);
  }
})();

out(`\nrefresh-readonly: ${passed} passed`);
