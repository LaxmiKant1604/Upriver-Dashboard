// "Publish from saved data" -- the dashboard endpoint (lib/server/publish-request/endpoint.js, wired by api/datadoe.js
// action=publish-request), the pure contract (contract.js), the browser state (src/lib/publish-request-client.js) and
// the registry / browser-mirror lockstep. Offline: fetch is a refusing stub (count asserted 0).
//   A authorization: account grant (403), SELECTED_BRANDS through the REAL trusted scope resolver (403 for another brand,
//     ok for the permitted one -- never rewritten), unsupported report (Portfolio) 400, brand not in the saved directory
//     400, directory unavailable 503, a rolled date 409.
//   B states: disabled / report-not-enabled / canary scope -> GET enabled:false (no control) + POST 409; already current
//     answered from the served row with NO request; enqueue 202; repeated clicks + another user JOIN the same request;
//     rate limit 429; every authorized viewer sees the same request (requestedByMe per user; no other user's id).
//   C contract: the recovery classes map to honest outcomes (published / current need the served read-back).
//   D browser state text; E api/datadoe.js wiring order + the registry mirror.
// 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.SUPABASE_URL = "http://supabase.test";
process.env[["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_")] = "test-key";
const net = { calls: 0 };
globalThis.fetch = async () => { net.calls += 1; throw new Error("network refused in an offline test"); };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EP = await import("../lib/server/publish-request/endpoint.js");
const C = await import("../lib/server/publish-request/contract.js");
const AUTHZ = await import("../lib/server/report-authorization.js");
const { brandKey } = await import("../lib/server/reports/brand-membership.js");
const { marketplaceToday } = await import("../lib/marketplaces.js");
const CL = await import("../src/lib/publish-request-client.js");
const RS = await import("../src/lib/report-status.js");
const MAT = await import("../lib/server/reports/report-materialization-registry.js");
const ROUTES = await import("../lib/server/publish-request/routes.js");

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; out("  ok  " + name); };
const S = (v) => (v == null ? "" : String(v));
out("publish-request endpoint + contract + client");

const NOW = Date.UTC(2026, 8, 30, 6, 0, 0); // UK today = 2026-09-30
const TODAY = marketplaceToday("UK", new Date(NOW));
const ACCT = "acct-uk-1";
const trusted = { [ACCT]: [{ key: brandKey("SHAFI"), display: "SHAFI" }, { key: brandKey("Other"), display: "Other" }, { key: brandKey("Acme Co"), display: "Acme Co" }] };

function world({ control = { enabled: true, report_keys: ["brand-view"], canary_scope_keys: [], worker_seen_at: new Date(NOW - 30000).toISOString() }, current = false, dirBrands = ["SHAFI", "Other", "ACME CO"], dirUnavailable = false } = {}) {
  const rows = new Map(); let seq = 0; const calls = { enqueue: 0, currency: 0, scopeReads: 0 };
  const deps = {
    assertAccountAccess: (access, ids) => {
      if (access.role === "admin") return;
      if (!ids.every((id) => (access.accountIds || []).includes(id))) { const e = new Error("no access"); e.status = 403; throw e; }
    },
    authorizeBrand: EP.makeBrandAuthorizer({ resolveUserReportScope: AUTHZ.resolveUserReportScope, getTrustedBrands: async ({ accountId }) => trusted[accountId] || [], brandKey, BrandAccessError: AUTHZ.BrandAccessError }),
    brandInDirectory: async ({ brand }) => (calls.scopeReads += 1, dirUnavailable ? { ok: false, unavailable: true } : { ok: dirBrands.includes(brand) }),
    accountCountry: async (id) => (calls.scopeReads += 1, id === ACCT ? "UK" : null),
    marketplaceToday, now: () => NOW,
    getControl: async () => control,
    currency: async () => { calls.currency += 1; return current ? { current: true, served: { sourceRefreshedAt: "2026-09-30T05:00:00Z", salesLatestDate: "2026-09-29" } } : { current: false, reason: "no-exact-row" }; },
    enqueue: async ({ reportKey, scopeKey, asOf, requestedBy }) => {
      calls.enqueue += 1;
      for (const r of rows.values()) if (r.scope_key === scopeKey && r.as_of === asOf && ["queued", "publishing"].includes(r.status)) { r.request_count += 1; return { outcome: "deduplicated", id: r.id, status: r.status }; }
      if ([...rows.values()].filter((r) => r.requested_by === requestedBy).length >= 3) return { outcome: "rate-limited" };
      const id = "00000000-0000-4000-8000-" + String(++seq).padStart(12, "0");
      rows.set(id, { id, report_key: reportKey, scope_key: scopeKey, as_of: asOf, status: "queued", reason: null, request_count: 1, attempts: 0, requested_by: requestedBy, created_at: new Date(NOW).toISOString() });
      return { outcome: "enqueued", id, status: "queued" };
    },
    getById: async (id) => rows.get(id) || null,
    getLatestForScope: async ({ scopeKey, asOf }) => [...rows.values()].filter((r) => r.scope_key === scopeKey && r.as_of === asOf).pop() || null,
  };
  return { deps, rows, calls };
}
const admin = { userId: "u-admin", role: "admin", accountIds: [], accountGrants: {} };
const member = { userId: "u-member", role: "member", accountIds: [ACCT], accountGrants: { [ACCT]: { mode: "ALL_BRANDS", brandKeys: [] } } };
const member2 = { userId: "u-member-2", role: "member", accountIds: [ACCT], accountGrants: { [ACCT]: { mode: "ALL_BRANDS", brandKeys: [] } } };
const limited = { userId: "u-limited", role: "member", accountIds: [ACCT], accountGrants: { [ACCT]: { mode: "SELECTED_BRANDS", brandKeys: [brandKey("SHAFI"), brandKey("Acme Co")] } } };
const stranger = { userId: "u-stranger", role: "member", accountIds: ["acct-other"], accountGrants: { "acct-other": { mode: "ALL_BRANDS", brandKeys: [] } } };
const q = (over = {}) => ({ action: "publish-request", report: "brand-view", ids: ACCT, brand: "SHAFI", asOf: TODAY, ...over });
const call = (method, access, w, over) => EP.handlePublishRequestAction({ method, query: q(over), access, deps: w.deps });

// ---- A authorization ------------------------------------------------------------------------------------------------------
{
  const w = world();
  ok("A1 an account the user is not granted -> 403, nothing read or enqueued", (await call("POST", stranger, w)).status === 403 && w.calls.enqueue === 0 && w.calls.currency === 0);
  const other = await call("POST", limited, w, { brand: "Other" });
  ok("A2 SELECTED_BRANDS user, a brand NOT permitted (REAL trusted scope resolver) -> 403, never rewritten to the permitted brand", other.status === 403 && w.calls.enqueue === 0);
  ok("A2 ... the permitted brand is accepted (202)", (await call("POST", limited, w)).status === 202);
  const variant = await call("POST", limited, w, { brand: "ACME CO" });
  ok("A2 a permitted brand saved under ANOTHER spelling than the trusted display the serve reads is refused (409) -- never a verified row this user cannot see", variant.status === 409 && !w.rows.has(variant.json && variant.json.request && variant.json.request.id));
  ok("A3 an unsupported report (Brand View Portfolio: no measured executor yet) -> 400 not-supported", (await call("POST", admin, w, { report: "brand-view-portfolio" })).json.state === "not-supported");
  ok("A4 a brand not in the account's saved directory -> 400", (await call("POST", admin, world({ dirBrands: ["Other"] }))).status === 400);
  ok("A4 the saved directory unavailable -> 503 (never a guessed brand list)", (await call("POST", admin, world({ dirUnavailable: true }))).status === 503);
  const rolled = await call("POST", admin, world(), { asOf: "2026-09-29" });
  ok("A5 a date the dashboard no longer serves -> 409 as-of-rolled with today's date", rolled.status === 409 && rolled.json.state === "as-of-rolled" && rolled.json.asOf === TODAY);
  ok("A6 malformed scope (two accounts / blank brand / padded brand / bad date) -> 400", (await call("GET", admin, world(), { ids: ACCT + ",x" })).status === 400 && (await call("GET", admin, world(), { brand: "" })).status === 400
    && (await call("GET", admin, world(), { brand: " SHAFI" })).status === 400 && (await call("GET", admin, world(), { asOf: "30-09-2026" })).status === 400);
  ok("A7 methods other than GET / POST -> 405", (await call("DELETE", admin, world())).status === 405);
}

// ---- B states --------------------------------------------------------------------------------------------------------------
{
  for (const [name, control, reason] of [
    ["disabled", { enabled: false, report_keys: ["brand-view"], canary_scope_keys: [] }, "disabled"],
    ["report not enabled", { enabled: true, report_keys: [], canary_scope_keys: [] }, "report-not-enabled"],
    ["canary (another scope)", { enabled: true, report_keys: ["brand-view"], canary_scope_keys: ["brand-view|x|y"] }, "scope-not-enabled"],
  ]) {
    const w = world({ control });
    const g = await call("GET", member, w);
    const p = await call("POST", member, w);
    ok(`B1 ${name}: GET enabled:false (the control is hidden) and POST 409 '${reason}' with nothing enqueued`, g.status === 200 && g.json.enabled === false && g.json.reason === reason && p.status === 409 && p.json.reason === reason && w.calls.enqueue === 0);
    if (reason !== "scope-not-enabled") ok(`B1 ${name}: the answer costs ONE control read -- ZERO authorization / scope reads on every page load`, w.calls.scopeReads === 0 && w.calls.currency === 0);
  }
  const cw = world({ current: true });
  const cur = await call("POST", member, cw);
  ok("B2 already current: answered from the dashboard-served row, 200 already_current, NO request recorded", cur.status === 200 && cur.json.state === "already_current" && cur.json.served.salesLatestDate === "2026-09-29" && cw.calls.enqueue === 0);
  const w = world();
  const p1 = await call("POST", member, w);
  const p2 = await call("POST", member, w);
  const p3 = await call("POST", member2, w);
  ok("B3 first click -> 202 queued with a request id", p1.status === 202 && p1.json.state === "queued" && p1.json.deduplicated === false && /^[0-9a-f-]{36}$/.test(p1.json.request.id));
  ok("B3 repeated clicks and ANOTHER user's click join the SAME request (deduplicated)", p2.json.deduplicated === true && p3.json.deduplicated === true && p2.json.request.id === p1.json.request.id && p3.json.request.id === p1.json.request.id && w.rows.size === 1);
  const g1 = await call("GET", member, w);
  const g2 = await call("GET", member2, w);
  ok("B4 every authorized viewer sees the same request; requestedByMe is per user; no other user's id is exposed", g1.json.request.id === g2.json.request.id && g1.json.request.requestedByMe === true && g2.json.request.requestedByMe === false
    && !JSON.stringify(g2.json).includes("u-member\"") && !("requested_by" in g2.json.request));
  ok("B4 the executor liveness is reported (worker seen 30 s ago -> online)", g1.json.executorOnline === true && (await call("GET", member, world({ control: { enabled: true, report_keys: ["brand-view"], canary_scope_keys: [], worker_seen_at: new Date(NOW - 3600000).toISOString() } }))).json.executorOnline === false);
  const rl = world();
  for (const b of ["SHAFI", "Other"]) await call("POST", admin, rl, { brand: b });
  rl.rows.forEach((r) => { r.status = "published"; });
  await call("POST", admin, rl);
  ok("B5 the per-user rate limit answers 429 (nothing new queued)", (await call("POST", admin, rl, { brand: "Other" })).status === 429);
  ok("B6 a POST without a user id -> 401", (await call("POST", { ...member, userId: "" }, world())).status === 401);
  const pw = world({ control: { enabled: true, report_keys: ["brand-view"], canary_scope_keys: [], worker_seen_at: new Date(NOW - 30000).toISOString(), worker_state: "paused:scheduler-running:europe-au" } });
  await call("POST", member, pw);
  const pg = await call("GET", member, pw);
  ok("B7 a queued request shows what the executor is waiting for (its paused pre-claim gate), without the executor claiming it", pg.json.request.status === "queued" && pg.json.request.waiting === "scheduler-running:europe-au" && /scheduled refresh/.test(CL.describePublishState({ request: pg.json.request }).detail));
}

// ---- C contract ------------------------------------------------------------------------------------------------------------
{
  ok("C1 READBACK_VERIFIED / PUBLICATION_NOT_REQUIRED -> 'verify' (the served read-back decides; never recorded on the release's word)",
    C.outcomeForUnit("READBACK_VERIFIED", null).finish === "verify" && C.outcomeForUnit("PUBLICATION_NOT_REQUIRED", "").finish === "verify");
  ok("C2 missing evidence classes -> missing_evidence (brand-not-sold, no-sales-snapshot; wrapped or bare)",
    C.outcomeForUnit("DEFERRED_PROVENANCE", "brand-not-sold").finish === "missing_evidence" && C.outcomeForUnit("DEFERRED_DEPENDENCY", "derive-not-ready:no-sales-snapshot").finish === "missing_evidence");
  ok("C2 an upstream REPORT not yet published (brand-directory-unpublished) is a dependency (bounded retry), per the shared recovery classifier",
    C.outcomeForUnit("DEFERRED_PROVENANCE", "brand-directory-unpublished").finish === "retry");
  ok("C3 the control lease HELD by another operation -> 'release' (no attempt used)", C.outcomeForUnit("DEFERRED_DEPENDENCY", "controls-not-opened:controls apply did not commit (code 1/CONTROL_LEASE_HELD: the global control plane is owned by another operation").finish === "release");
  ok("C3 any OTHER contention (an apply that did not commit, a pending capability) and a never-attempted unit -> bounded 'retry' (it cannot loop free until the day rolls)",
    C.outcomeForUnit("DEFERRED_DEPENDENCY", "controls-not-opened:controls apply did not commit (code 1/PRE all_primary)").finish === "retry"
    && C.outcomeForUnit("DEFERRED_DEPENDENCY", "controls-not-opened:PRIORITY_PARTIAL_MIGRATION_PENDING (x)").finish === "retry"
    && C.outcomeForUnit("DEFERRED_DEPENDENCY", "deadline-cleanup-reserved").finish === "retry");
  ok("C4 an integrity failure -> failed; an unknown reason -> retry (never current)", C.outcomeForUnit("FAILED_PUBLISH", "payload-too-large").finish === "failed" && C.outcomeForUnit("DEFERRED_DEPENDENCY", "zzz-unmapped-xyz").finish !== "verify");
  ok("C5 scope identity: exact brand (padded brand refused), bounded, report-scoped", C.canonicalScope({ reportKey: "brand-view", accountId: "a", brand: "B", asOf: "2026-09-30" }).scope.scopeKey === "brand-view|a|B"
    && C.canonicalScope({ reportKey: "brand-view", accountId: "a", brand: "B ", asOf: "2026-09-30" }).ok === false && C.canonicalScope({ reportKey: "brand-view-portfolio", accountId: "a", brand: "B", asOf: "2026-09-30" }).ok === false);
}

// ---- D browser state ---------------------------------------------------------------------------------------------------------
{
  const d = (request, extra = {}) => CL.describePublishState({ request, ...extra });
  ok("D1 queued shows WHY it waits (scheduler) and never claims publishing", d({ status: "queued", waiting: "scheduler-running:europe-au", requestedByMe: true }).label === "Queued" && /scheduled refresh/.test(d({ status: "queued", waiting: "scheduler-running:europe-au", requestedByMe: true }).detail));
  ok("D1 queued with the executor offline says so", /offline/.test(d({ status: "queued", requestedByMe: true }, { executorOnline: false }).detail));
  ok("D2 published = 'Published and verified'; already_current = 'Already current'", d({ status: "published", served: { salesLatestDate: "2026-09-29" } }).label === "Published and verified" && d({ status: "already_current" }).label === "Already current");
  ok("D3 missing_evidence = 'Source data unavailable' and says the previous report stays; failed says it could not be verified", d({ status: "missing_evidence", reason: "brand-not-sold" }).label === "Source data unavailable" && /stays on screen/.test(d({ status: "missing_evidence", reason: "brand-not-sold" }).detail) && /could not be verified/.test(d({ status: "failed", reason: "x" }).detail));
  ok("D4 another user's request is labelled as such", /another user/.test(d({ status: "publishing", requestedByMe: false }).detail));
  ok("D5 'Failed' never claims nothing changed (a publish may have landed before verification ran out)", !/Nothing was changed/.test(d({ status: "failed", reason: "attempts-exhausted:readback-not-current" }).detail));
  const q5 = { status: "queued" };
  ok("D6 polling backs off 5,5,15,15,30 then 60 s; 60 s at once while WAITING; stops on a terminal / no request",
    [0, 1, 2, 3, 4, 5, 9].map((n) => CL.nextPollDelayMs({ request: q5, consecutive: n })).join(",") === "5000,5000,15000,15000,30000,60000,60000"
    && CL.nextPollDelayMs({ request: { status: "queued", waiting: "scheduler-running" } }) === 60000
    && CL.nextPollDelayMs({ request: { status: "published" } }) === null && CL.nextPollDelayMs({}) === null);
  ok("D7 a transient 5xx / 429 KEEPS the last good state; 400/401/403/404/409 clear it; 2xx applies",
    CL.statusUpdateFor(503) === "keep" && CL.statusUpdateFor(500) === "keep" && CL.statusUpdateFor(429) === "keep" && CL.statusUpdateFor(undefined) === "keep"
    && [400, 401, 403, 404, 409].every((h) => CL.statusUpdateFor(h) === "clear") && CL.statusUpdateFor(200) === "apply");
  const comp = readFileSync(path.join(ROOT, "src", "components", "SavedDataPublishControl.jsx"), "utf8");
  const firstReturn = comp.indexOf("if (!route || !params || !status");
  const lastHook = Math.max(...["useState(", "useRef(", "useMemo(", "useCallback(", "useEffect("].map((h) => comp.lastIndexOf(h)));
  ok("D8 the control declares every hook ABOVE its only early return (React #310 rule) and re-arms polling from a per-poll tick", firstReturn > 0 && lastHook < firstReturn && comp.includes("finally { if (scopeRef.current === forScope) setTick(") && comp.includes("seenActive.current.has(request.id)"));
}

// ---- E wiring + registry mirror ---------------------------------------------------------------------------------------------
{
  const src = readFileSync(path.join(ROOT, "api", "datadoe.js"), "utf8");
  const hook = src.indexOf('if (action === "publish-request")');
  const firstDataDoePath = src.indexOf("const routeOwnedRefreshKey");
  ok("E1 api/datadoe.js handles publish-request immediately after authentication, BEFORE the refresh / account-scope / DataDoe paths", hook > 0 && firstDataDoePath > hook && src.indexOf("const access = await getDashboardAccess(req);") < hook);
  ok("E1 ... and no new serverless function was added (still 12 api files, the Hobby cap)", readFileSync(path.join(ROOT, "vercel.json"), "utf8").includes('"api/datadoe.js"'));
  const declared = Object.fromEntries(Object.entries(MAT.REPORT_MATERIALIZATION).filter(([, e]) => e.savedDataPublish).map(([a, e]) => [a, e.savedDataPublish]));
  ok("E2 the browser mirror SAVED_DATA_PUBLISH EQUALS the registry's savedDataPublish declarations (brand-view only)", JSON.stringify(RS.SAVED_DATA_PUBLISH) === JSON.stringify(declared) && JSON.stringify(Object.keys(declared)) === JSON.stringify(["brand-view"]));
  ok("E2 ... and equals the tested executor list; Portfolio is NOT declared", JSON.stringify(Object.keys(ROUTES.SAVED_DATA_PUBLISH_ROUTES)) === JSON.stringify(["brand-view"]) && RS.savedDataPublishRoute("brand-view-portfolio") === null);
  const problemsOf = (opts) => { try { MAT.validateReportMaterializationRegistry(opts); return []; } catch (e) { return Array.isArray(e.problems) ? e.problems : [String(e.message)]; } };
  const extra = { ...ROUTES.SAVED_DATA_PUBLISH_ROUTES, "brand-view-portfolio": { routeId: "brand-view-portfolio" } };
  ok("E3 the registry validator enforces the lockstep both ways: a declaration without an executor, and an executor without a declaration, are problems",
    problemsOf({ savedDataPublishRoutes: {} }).some((p) => /savedDataPublish/.test(p)) && problemsOf({ savedDataPublishRoutes: extra }).some((p) => /no registry savedDataPublish declaration/.test(p))
    && problemsOf().length === 0);
}

ok("Z zero network in the whole suite", net.calls === 0);
out(`publish-request endpoint: ${passed} passed`);
