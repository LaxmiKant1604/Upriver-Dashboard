// ACCOUNT-scoped FBA Shipment Plan column-visibility ENDPOINT proof suite (offline, ZERO network/DB/DataDoe).
//
// Drives the REAL handler (api/fba-plan-columns.js) with injected deps + the REAL assertAccountAccess / DashboardAccessError
// and the REAL validateHiddenColumns registry. Proves: account SHARING (user A saves X, user B reads the same X),
// account ISOLATION (X vs Y; same account_id under a different org/connection never collides), AUTHORIZATION
// (401 unauth, 403 unauthorized with ZERO writes, browser org/connection cannot retarget), VALIDATION (unknown /
// locked / duplicate / malformed / over-max rejected, zero writes), and DEFAULTS (unsaved -> default; Select All ->
// empty; Reset -> default). SKU Movement's user-scoped table + functions are never referenced by this endpoint.
// 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["t", "svc", "role", "k"].join("-");

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "fba-plan-account-columns\n");

const api = await import("../api/fba-plan-columns.js");
const { assertAccountAccess } = await import("../lib/server/supabase.js");
const cols = await import("../lib/fba-plan-columns.js");
const handler = api.handler;

const SERVER_ORG = "org-primary-fingerprint"; // what orgFingerprint() would derive server-side
// A full-identity store: keyed by org|connection|account|report. Records every write for zero-write assertions.
function makeStore() {
  const rows = new Map();
  const key = (o, c, a, r) => [o, c, a, r].join("|");
  return {
    writes: 0, _rows: rows,
    async getFbaPlanAccountColumnPrefs({ organizationFingerprint, connectionId, accountId, reportKey }) {
      const row = rows.get(key(organizationFingerprint, connectionId, accountId, reportKey));
      return row ? { hiddenColumns: [...row.hiddenColumns], updatedAt: row.updatedAt } : { hiddenColumns: [], updatedAt: null };
    },
    async setFbaPlanAccountColumnPrefs({ organizationFingerprint, connectionId, accountId, reportKey, hiddenColumns, updatedBy, updatedByEmail }) {
      this.writes += 1;
      const stored = { hiddenColumns: [...hiddenColumns], updatedAt: new Date(1e12 + this.writes).toISOString(), updatedBy, updatedByEmail };
      rows.set(key(organizationFingerprint, connectionId, accountId, reportKey), stored);
      return { hiddenColumns: [...stored.hiddenColumns], updatedAt: stored.updatedAt };
    },
  };
}
// access: { userId, email, role, accountIds }. null => unauthenticated (getDashboardAccess throws 401-shaped).
function makeDeps(store, access, { org = SERVER_ORG } = {}) {
  const audits = [];
  return {
    store, audits,
    getDashboardAccess: async () => { if (!access) { const e = new Error("Please sign in."); e.status = 401; e.name = "DashboardAccessError"; throw Object.assign(e, { __isDashErr: true }); } return access; },
    assertAccountAccess, // REAL authorization (admins bypass; a member must hold the account)
    getFbaPlanAccountColumnPrefs: (a) => store.getFbaPlanAccountColumnPrefs(a),
    setFbaPlanAccountColumnPrefs: (a) => store.setFbaPlanAccountColumnPrefs(a),
    insertAuditLog: async (e) => { audits.push(e); },
    orgFingerprint: () => org, // SERVER-derived; the handler must NEVER use a browser-supplied org
  };
}
// getDashboardAccess must throw a DashboardAccessError for 401; use the real class so `instanceof` in the handler works.
async function withRealAuthError(deps) {
  const { DashboardAccessError } = await import("../lib/server/supabase.js");
  const orig = deps.getDashboardAccess;
  deps.getDashboardAccess = async (req) => { try { return await orig(req); } catch (e) { if (e && e.__isDashErr) throw new DashboardAccessError("Please sign in.", 401); throw e; } };
  return deps;
}
function res() { return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; }
const GET = (accountId) => ({ method: "GET", query: { accountId }, body: null });
const POST = (body) => ({ method: "POST", query: {}, body });
const admin = { userId: "u-admin", email: "a@x", role: "admin", accountIds: [] };
const userA = { userId: "u-A", email: "A@x", role: "editor", accountIds: ["X", "Y"] };
const userB = { userId: "u-B", email: "B@x", role: "viewer", accountIds: ["X"] };

/* ============================ A. ACCOUNT SHARING ============================ */
await (async () => {
  const store = makeStore();
  // User A saves a layout for account X.
  let r = res(); await handler(POST({ accountId: "X", hiddenColumns: ["m1", "wdd", "priority"] }), r, await withRealAuthError(makeDeps(store, userA)));
  ok("A: user A save for X returns 200 + canonical hidden set", r.code === 200 && r.body.accountId === "X" && r.body.hiddenColumns.slice().sort().join(",") === "m1,priority,wdd");
  // User B (a DIFFERENT user, authorized for X) reads X -> the SAME layout A saved.
  r = res(); await handler(GET("X"), r, await withRealAuthError(makeDeps(store, userB)));
  ok("A: user B reads X and receives A's shared layout", r.code === 200 && r.body.accountId === "X" && r.body.updatedAt && r.body.hiddenColumns.slice().sort().join(",") === "m1,priority,wdd");
})();

/* ============================ B. ACCOUNT ISOLATION ============================ */
await (async () => {
  const store = makeStore();
  let r = res(); await handler(POST({ accountId: "X", hiddenColumns: ["m1"] }), r, await withRealAuthError(makeDeps(store, userA)));
  r = res(); await handler(POST({ accountId: "Y", hiddenColumns: ["m2", "m3"] }), r, await withRealAuthError(makeDeps(store, userA)));
  let rx = res(); await handler(GET("X"), rx, await withRealAuthError(makeDeps(store, userA)));
  let ry = res(); await handler(GET("Y"), ry, await withRealAuthError(makeDeps(store, userA)));
  ok("B: X and Y keep independent layouts", rx.body.hiddenColumns.join(",") === "m1" && ry.body.hiddenColumns.slice().sort().join(",") === "m2,m3");
  // Same account_id "X" under a DIFFERENT org cannot collide: an org2 read sees nothing of org1's X.
  let r2 = res(); await handler(GET("X"), r2, await withRealAuthError(makeDeps(store, admin, { org: "org-TWO" })));
  ok("B: same account_id under a different organization does not collide (unsaved -> default)", r2.body.updatedAt === null && r2.body.hiddenColumns.length === 0);
})();

/* ============================ C. AUTHORIZATION ============================ */
await (async () => {
  const store = makeStore();
  // Unauthenticated -> 401, zero writes.
  let r = res(); await handler(POST({ accountId: "X", hiddenColumns: ["m1"] }), r, await withRealAuthError(makeDeps(store, null)));
  ok("C: unauthenticated POST -> 401, zero writes", r.code === 401 && store.writes === 0);
  r = res(); await handler(GET("X"), r, await withRealAuthError(makeDeps(store, null)));
  ok("C: unauthenticated GET -> 401", r.code === 401);
  // Authenticated but NOT authorized for the account -> 403, zero writes (userB holds only X, not Z).
  r = res(); await handler(POST({ accountId: "Z", hiddenColumns: ["m1"] }), r, await withRealAuthError(makeDeps(store, userB)));
  ok("C: unauthorized POST -> 403, zero writes", r.code === 403 && store.writes === 0);
  r = res(); await handler(GET("Z"), r, await withRealAuthError(makeDeps(store, userB)));
  ok("C: unauthorized GET -> 403", r.code === 403);
  // Browser-supplied organization/connection cannot retarget: the write lands under the SERVER org + primary.
  r = res(); await handler(POST({ accountId: "X", hiddenColumns: ["m1"], organization_fingerprint: "EVIL-ORG", connection_id: "dd-secondary", organizationFingerprint: "EVIL-ORG" }), r, await withRealAuthError(makeDeps(store, userA)));
  ok("C: browser org/connection are IGNORED -- stored under the server identity only", r.code === 200 && store._rows.has([SERVER_ORG, "primary", "X", "fba-plan"].join("|")) && !store._rows.has(["EVIL-ORG", "dd-secondary", "X", "fba-plan"].join("|")));
  // A missing accountId -> 400 (before any store touch).
  r = res(); const d = await withRealAuthError(makeDeps(store, userA)); const before = store.writes; await handler(POST({ hiddenColumns: ["m1"] }), r, d);
  ok("C: missing accountId -> 400, zero writes", r.code === 400 && store.writes === before);
})();

/* ============================ E. VALIDATION ============================ */
await (async () => {
  const store = makeStore();
  const bad = async (hiddenColumns, label) => { const r = res(); const before = store.writes; await handler(POST({ accountId: "X", hiddenColumns }), r, await withRealAuthError(makeDeps(store, userA))); ok(`E: ${label} -> 400, zero writes`, r.code === 400 && store.writes === before); };
  await bad(["nope"], "unknown id");
  await bad(["asin"], "locked Product/ASIN cannot be hidden");
  await bad(["m1", "m1"], "duplicate id");
  await bad([" m1"], "whitespace-padded / malformed id");
  await bad([123], "non-string id");
  await bad("m1", "non-array body");
  await bad(cols.FBA_PLAN_COLUMN_IDS.concat(["m1"]), "over the maximum count");
  // AWD ids ARE valid in a saved hidden set (marketplace eligibility is a client display concern).
  const r = res(); await handler(POST({ accountId: "X", hiddenColumns: ["awd", "awdInbound"] }), r, await withRealAuthError(makeDeps(store, userA)));
  ok("E: AWD ids are accepted (valid hideable ids)", r.code === 200 && r.body.hiddenColumns.slice().sort().join(",") === "awd,awdInbound");
})();

/* ============================ F. DEFAULTS + COMMANDS ============================ */
await (async () => {
  const store = makeStore();
  // No saved row -> default (updatedAt null; the endpoint surfaces the default set).
  let r = res(); await handler(GET("X"), r, await withRealAuthError(makeDeps(store, userA)));
  ok("F: unsaved account -> updatedAt null + default hidden columns surfaced", r.code === 200 && r.body.updatedAt === null && r.body.defaultHiddenColumns.slice().sort().join(",") === [...cols.PLAN_DEFAULT_HIDDEN_COLS].sort().join(","));
  // Select All -> persist an intentionally EMPTY hidden set (a real saved row with updatedAt).
  r = res(); await handler(POST({ accountId: "X", hiddenColumns: [] }), r, await withRealAuthError(makeDeps(store, userA)));
  ok("F: Select All persists an empty hidden set", r.code === 200 && r.body.hiddenColumns.length === 0 && r.body.updatedAt);
  r = res(); await handler(GET("X"), r, await withRealAuthError(makeDeps(store, userB)));
  ok("F: a reload (different authorized user) reads the persisted empty set (updatedAt present => not default)", r.body.updatedAt && r.body.hiddenColumns.length === 0);
  // Reset Default -> persist the exact default set.
  r = res(); await handler(POST({ accountId: "X", hiddenColumns: [...cols.PLAN_DEFAULT_HIDDEN_COLS] }), r, await withRealAuthError(makeDeps(store, userA)));
  ok("F: Reset Default persists the exact default set", r.code === 200 && r.body.hiddenColumns.slice().sort().join(",") === [...cols.PLAN_DEFAULT_HIDDEN_COLS].sort().join(","));
})();

/* ============================ G. SKU MOVEMENT REGRESSION (source guard) ============================ */
(() => {
  const src = readFileSync(new URL("../api/fba-plan-columns.js", import.meta.url), "utf8");
  ok("G: the FBA columns endpoint no longer imports the per-user (SKU-Movement-shared) prefs functions", !/getFbaPlanColumnPrefs\b/.test(src) && !/setFbaPlanColumnPrefs\b/.test(src));
  ok("G: the FBA columns endpoint reads/writes ONLY the account-scoped store functions", /getFbaPlanAccountColumnPrefs/.test(src) && /setFbaPlanAccountColumnPrefs/.test(src));
  ok("G: the FBA columns endpoint never references the SKU Movement prefs endpoint/table", !/sku-movement-prefs/.test(src) && !/fba_plan_column_prefs\b/.test(src));
})();

writeSync(1, `\nfba-plan-account-columns: ${passed} assertions passed\n`);
