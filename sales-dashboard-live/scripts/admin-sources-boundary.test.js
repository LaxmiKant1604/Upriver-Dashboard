// API-BOUNDARY tests for api/admin/sources.js: execute the REAL handler(req,res,deps) with mocked collaborators and
// the REAL centralized cutover authority (active-ads-source.isAdsRegistryKeyRetired). Proves a forged retired-ASIN
// POST/PATCH returns 409 SOURCE_RETIRED at the endpoint -- BEFORE runtime construction, preflightEvidence, coverage,
// discovery, audit, setSourceControl, statusPayload, DataDoe/token -- while Campaign + every non-retired source keep
// their current behavior, and unauthenticated/non-admin callers keep 401/403 (and never see SOURCE_RETIRED).
// WP10b re-verify P1 (tests 11-24): the Campaign-Ads paid-sync steps are SINGLE-USE through a durable receipt (an
// explicit-primary-key insert into public.audit_log) claimed BEFORE the runner: a replayed start / older continuation
// token and a concurrent duplicate get 409 PAID_SYNC_TOKEN_CONSUMED with ZERO runner calls; the token's Ads slice
// sequence (aq) is HMAC-bound and a pre-change (v2) token is refused; the approval figures are post-slice (P3-3);
// verified continuation polls have their own limiter budget (P3-5); contention / refusal responses carry a message (P3-6).
// The REAL supabase.js claimPaidSyncReceipt runs against an offline PostgREST emulation of audit_log's primary key
// (global fetch stub: every OTHER request is refused -- ZERO network, ZERO database, ZERO DataDoe).
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy env.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

// ---- the offline network: an emulated PostgREST audit_log (primary key = the explicit id) + REFUSE everything else ----
// Installed BEFORE any module loads. A duplicate id answers exactly what PostgREST answers for a unique violation (HTTP
// 409, code 23505); `net.nextAudit` injects a one-shot response for the claimPaidSyncReceipt mapping tests. The
// check-and-insert is synchronous (no await between them), so two concurrent claims serialize exactly like the database.
const net = { calls: [], audit: new Map(), auditPosts: [], nextAudit: null };
const fakeFetchRes = (status, body) => ({
  ok: status >= 200 && status < 300, status, headers: { get: () => null },
  json: async () => { if (body == null) throw new SyntaxError("Unexpected end of JSON input"); return body; },
  text: async () => (body == null ? "" : JSON.stringify(body)),
});
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = String((opts && opts.method) || "GET").toUpperCase();
  net.calls.push(method + " " + u);
  if (method === "POST" && /\/rest\/v1\/audit_log$/.test(u.split("?")[0])) {
    net.auditPosts.push({ url: u, headers: { ...(opts.headers || {}) }, body: JSON.parse(opts.body) });
    if (net.nextAudit) { const f = net.nextAudit; net.nextAudit = null; return f(); }
    const row = JSON.parse(opts.body);
    if (net.audit.has(row.id)) return fakeFetchRes(409, { code: "23505", message: "duplicate key value violates unique constraint \"audit_log_pkey\"" });
    net.audit.set(row.id, row);
    return fakeFetchRes(201, null); // Prefer: return=minimal -> an empty body
  }
  throw new Error("NETWORK_REFUSED_BY_TEST: " + method + " " + u);
};

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let handler, isAdsRegistryKeyRetired, RS, claimPaidSyncReceipt;

function fakeRes() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

// A minimal deadline object; a forged retired action never reaches it (the gate is before runtime construction).
function fakeDeadline() {
  return {
    makeDeadline() { return this; },
    deadlineMs: Date.now() + 60_000, reserveMs: 3000,
    outOfTime: () => false, isDeadlineError: () => false,
    ensureTime: async () => {},
    bound: async (_label, fn) => fn(() => {}),
  };
}

function makeDeps(over = {}) {
  const calls = { audit: [], setSourceControl: [], preflight: [], runtimeBuilt: 0, getSourceControls: 0, getSourceRunStatuses: 0, directory: 0, runCardAction: [] };
  const runtime = {
    makeDeadline: () => fakeDeadline(),
    preflightEvidence: async (a) => { calls.preflight.push(a); if (over.preflightThrows) throw Object.assign(new Error("REACHED_PREFLIGHT"), { code: "REACHED_PREFLIGHT" }); return { evidence: {} }; },
    gatherDurableReadiness: async () => ({ unavailable: "test" }),
    runSourceCardAction: async (a) => { calls.runCardAction.push(a); return { refused: false, continuationRequired: false, cycleId: "cyc12345", globalDrained: true }; },
    run: async () => ({ ran: true }),
    store: { getCycleByBucketDate: async () => null },
  };
  const deps = {
    getDashboardAccess: over.getDashboardAccess || (async () => ({ userId: "admin1" })),
    assertAdmin: over.assertAdmin || (() => {}),
    // The REAL centralized authority (not a fake) drives the gate.
    isAdsRegistryKeyRetired,
    insertAuditLog: async (a) => { calls.audit.push(a); },
    setSourceControl: async (a) => { calls.setSourceControl.push(a); return { ok: true }; },
    getSourceControls: async () => { calls.getSourceControls += 1; return { rows: [], read: "ok" }; },
    getSourceRunStatuses: async () => { calls.getSourceRunStatuses += 1; return { rows: [], read: "ok" }; },
    getAccountDirectoryRows: async () => { calls.directory += 1; return []; },
    getAccountOliQualityCounts: async () => ({}),
    primaryOrganizationFingerprint: () => "org-fp",
    buildBucketSourceSyncRuntime: () => { calls.runtimeBuilt += 1; return runtime; },
    // WP10b paid-sync preview + execute-binding readers (read-only; offline doubles -- ZERO network / DataDoe): an empty
    // operation slot (no cycle yet, no persisted spend), no Catalog reservation, empty durable coverage.
    now: () => Date.UTC(2026, 8, 26, 3, 0),
    getDataDoeConnections: () => [{ id: "primary", apiKey: ["b", "key"].join("-"), accountPrefix: "", organizationFingerprint: "org-fp" }],
    getSyncCycleByBucketDate: async () => { calls.slotReads = (calls.slotReads || 0) + 1; if (over.slotThrows && calls.slotReads > (over.slotThrowsAfter || 0)) throw new Error("slot fork"); return null; },
    getSyncSourceJobs: async () => [],
    getPriorityCatalogReservation: async () => { calls.reservationReads = (calls.reservationReads || 0) + 1; return null; },
    getDailyAdsCoverage: async () => ({ read: "ok", windows: [], status: "missing" }),
    getSourceCoverageWindows: async () => ({ read: "ok", windows: [] }),
    getSourceSnapshot: async () => ({ read: "ok", snapshot: null }),
    listSourceBatchMembership: async () => [],
    getSourceTrancheBudget: async () => null,
    getSourceExportCacheMeta: async () => null,
    getRecentSyncCycleIds: async () => [],
    getSyncSourceJobsWithMeta: async () => [],
    getSyncSourceJobOwnersForCycle: async () => [],
  };
  return { deps, calls };
}

const noRetiredIO = (calls, label) => {
  assert.equal(calls.runtimeBuilt, 0, `${label}: no runtime constructed`);
  assert.equal(calls.preflight.length, 0, `${label}: no preflightEvidence / coverage / discovery`);
  assert.equal(calls.audit.length, 0, `${label}: no audit write`);
  assert.equal(calls.setSourceControl.length, 0, `${label}: no control write`);
  assert.equal(calls.runCardAction.length, 0, `${label}: no runSourceCardAction (no DataDoe/create/token)`);
  assert.equal(calls.getSourceControls, 0, `${label}: no statusPayload read`);
  assert.equal(calls.getSourceRunStatuses, 0, `${label}: no statusPayload read`);
  assert.equal(calls.directory, 0, `${label}: no discovery`);
};

test("1+2. forged admin POST for ads-asin-date -> 409 SOURCE_RETIRED, ZERO preflight/coverage/discovery/audit/create/token/status", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler({ method: "POST", body: { bucket: "us", sourceKey: "ads-asin-date" } }, res, deps);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, "SOURCE_RETIRED");
  assert.equal(res.body.sourceKey, "ads-asin-date");
  assert.match(res.body.message, /rollback/i);
  noRetiredIO(calls, "POST ads-asin-date");
});

test("3+4. forged admin PATCH for ads-asin-date -> 409 SOURCE_RETIRED, ZERO setSourceControl/insertAuditLog/status", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler({ method: "PATCH", body: { sourceKey: "ads-asin-date", paused: true } }, res, deps);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, "SOURCE_RETIRED");
  assert.equal(res.body.sourceKey, "ads-asin-date");
  assert.equal(calls.setSourceControl.length, 0, "no setSourceControl");
  assert.equal(calls.audit.length, 0, "no insertAuditLog");
  assert.equal(calls.getSourceControls, 0, "no status refresh");
  assert.equal(calls.getSourceRunStatuses, 0, "no status refresh");
});

test("5. unauthenticated -> 401 and non-admin -> 403; neither reaches the retired gate or reveals SOURCE_RETIRED", async () => {
  // Unauthenticated: getDashboardAccess throws a 401.
  const un = makeDeps({ getDashboardAccess: async () => { throw Object.assign(new Error("Not authenticated."), { status: 401 }); } });
  const r1 = fakeRes();
  await handler({ method: "POST", body: { bucket: "us", sourceKey: "ads-asin-date" } }, r1, un.deps);
  assert.equal(r1.statusCode, 401);
  assert.notEqual(r1.body.error, "SOURCE_RETIRED", "unauth caller is never told the source is retired");
  noRetiredIO(un.calls, "unauth POST");
  // Non-admin: assertAdmin throws a 403.
  const na = makeDeps({ assertAdmin: () => { throw Object.assign(new Error("Admin only."), { status: 403 }); } });
  const r2 = fakeRes();
  await handler({ method: "PATCH", body: { sourceKey: "ads-asin-date", paused: true } }, r2, na.deps);
  assert.equal(r2.statusCode, 403);
  assert.notEqual(r2.body.error, "SOURCE_RETIRED", "non-admin caller is never told the source is retired");
  assert.equal(na.calls.setSourceControl.length, 0, "non-admin never mutates the control");
});

test("6. legitimate admin PATCH for ads-campaign-date is NOT retired-blocked: setSourceControl + audit called, 200", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler({ method: "PATCH", body: { sourceKey: "ads-campaign-date", paused: true } }, res, deps);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(calls.setSourceControl.length, 1, "the active Campaign control IS written");
  assert.equal(calls.setSourceControl[0].sourceKey, "ads-campaign-date");
  assert.equal(calls.setSourceControl[0].paused, true);
  assert.equal(calls.audit.length, 1, "a normal pause is audited");
  assert.equal(calls.audit[0].action, "source.paused");
});

test("7. normal OLI + Catalog + FBA-health PATCH controls unchanged (not retired-blocked): control written + audited", async () => {
  for (const sourceKey of ["order-line-items", "product-catalog", "fba-inventory-health"]) {
    const { deps, calls } = makeDeps();
    const res = fakeRes();
    await handler({ method: "PATCH", body: { sourceKey, paused: false } }, res, deps);
    assert.equal(res.statusCode, 200, sourceKey + ": " + JSON.stringify(res.body));
    assert.equal(calls.setSourceControl.length, 1, sourceKey + ": control written");
    assert.equal(calls.audit.length, 1, sourceKey + ": audited");
    assert.equal(calls.audit[0].action, "source.resumed");
  }
});

test("6b. legitimate POST for ads-campaign-date passes the retired gate and REACHES preflightEvidence (not blocked)", async () => {
  const { deps, calls } = makeDeps({ preflightThrows: true }); // sentinel to bound the test at preflight
  // WP10b: the paid sync is a two-step contract -- a preview (zero writes, zero runtime) issues the explicit
  // confirmationToken the execute POST must carry; the execute then proceeds exactly as before.
  const pre = fakeRes();
  await handler({ method: "POST", body: { bucket: "us", sourceKey: "ads-campaign-date", preview: true } }, pre, deps);
  assert.equal(pre.statusCode, 200, JSON.stringify(pre.body));
  assert.equal(calls.runtimeBuilt, 0, "the preview constructs no runtime");
  assert.equal(calls.audit.length, 0, "the preview writes no audit row");
  const res = fakeRes();
  await handler({ method: "POST", body: { bucket: "us", sourceKey: "ads-campaign-date", confirmationToken: pre.body.preview.confirmationToken } }, res, deps);
  // The retired gate did NOT reject it: the runtime was built and preflightEvidence was reached.
  assert.equal(calls.runtimeBuilt >= 1, true, "runtime constructed for the active Campaign grain");
  assert.equal(calls.preflight.length, 1, "preflightEvidence reached (past the retired gate)");
  assert.equal(res.statusCode, 500, "bounded by the preflight sentinel");
  assert.equal(res.body.error, "REACHED_PREFLIGHT");
});

test("9. WP10b: a forged retired POST carrying a confirmationToken is refused at the retired gate BEFORE any paid-sync read (no operation-slot / reservation / directory read)", async () => {
  const { deps, calls } = makeDeps();
  const res = fakeRes();
  await handler({ method: "POST", body: { bucket: "us", sourceKey: "ads-asin-date", confirmationToken: "x.y" } }, res, deps);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, "SOURCE_RETIRED");
  assert.equal(calls.slotReads || 0, 0, "no operation-slot read");
  assert.equal(calls.reservationReads || 0, 0, "no reservation read");
  noRetiredIO(calls, "POST ads-asin-date + token");
});

test("10. WP10b: an execute whose operation state cannot be re-proven (slot read fails AFTER a good preview) is 503 PAID_SYNC_OPERATION_UNVERIFIABLE with ZERO runtime / preflight / audit", async () => {
  const { deps, calls } = makeDeps({ slotThrows: true, slotThrowsAfter: 1 }); // the preview's slot read succeeds; every later one fails
  const pre = fakeRes();
  await handler({ method: "POST", body: { bucket: "us", sourceKey: "order-line-items", preview: true } }, pre, deps);
  assert.equal(pre.statusCode, 200, JSON.stringify(pre.body));
  assert.equal(typeof pre.body.preview.confirmationToken, "string", "a good preview issues a token");
  const res = fakeRes();
  await handler({ method: "POST", body: { bucket: "us", sourceKey: "order-line-items", confirmationToken: pre.body.preview.confirmationToken } }, res, deps);
  assert.equal(res.statusCode, 503, JSON.stringify(res.body));
  assert.equal(res.body.error, "PAID_SYNC_OPERATION_UNVERIFIABLE");
  assert.equal(res.body.preview && res.body.preview.confirmationToken, null, "the refusal never hands out a token");
  assert.equal(calls.runtimeBuilt, 0, "no runtime");
  assert.equal(calls.preflight.length, 0, "no preflight");
  assert.equal(calls.audit.length, 0, "no audit");
});

test("8. the retirement gate uses the REAL centralized authority (ads-asin-date retired; ads-campaign-date not)", () => {
  assert.equal(isAdsRegistryKeyRetired("ads-asin-date"), true, "ASIN registry grain is retired while Campaign active");
  assert.equal(isAdsRegistryKeyRetired("ads-campaign-date"), false, "Campaign registry grain is never retired");
  assert.equal(isAdsRegistryKeyRetired("order-line-items"), false);
  assert.equal(isAdsRegistryKeyRetired("fba-inventory-health"), false);
});

// =====================================================================================================================
// WP10b re-verify P1: Campaign-Ads paid-sync steps are SINGLE-USE (durable receipt) -- the verifier's replay harness.
// =====================================================================================================================
// Three never-covered US accounts -> ONE initial batch: expected 1 create, worst case (1 + 3 bisection) x 2 = 8, + the
// release Catalog reserve 2 -> approved 10. The fake runner spends EVERYTHING its cap allows (a rejecting batch bisected
// to singles), so a slice's cap = floor((approved - debited - reserve 2) / 2) is exactly what it costs. Each environment
// is its own admin (the route's per-admin limiter windows are module-global).
const ADS_NOW = Date.UTC(2026, 8, 26, 3, 0); // server today 2026-09-26, as-of (D-1) 2026-09-25
const ADS_TODAY = "2026-09-26";
const ADS_KEY = Buffer.alloc(32, 7);
const ADS_BODY = { bucket: "us", sourceKey: "ads-campaign-date" };
let adsUserSeq = 0;
function makeAdsDeps(over = {}) {
  const uid = over.userId || ("ads-admin-" + (adsUserSeq += 1));
  const calls = { runner: [], audit: 0, preflight: 0 };
  const ledger = { tokens: 0 };
  const runtime = {
    makeDeadline: () => fakeDeadline(),
    preflightEvidence: async () => { calls.preflight += 1; return { today: ADS_TODAY, evidence: {} }; },
    gatherDurableReadiness: async () => ({ unavailable: "test" }),
  };
  const deps = {
    getDashboardAccess: async () => ({ userId: uid }),
    assertAdmin: () => {},
    isAdsRegistryKeyRetired,
    insertAuditLog: async () => { calls.audit += 1; },
    setSourceControl: async () => ({ ok: true }),
    getSourceControls: async () => ({ rows: [], read: "ok" }),
    getSourceRunStatuses: async () => ({ rows: [], read: "ok" }),
    getAccountDirectoryRows: async () => ["acctA", "acctB", "acctC"].map((id) => ({ account_id: id, marketplace_country_code: "US", sync_bucket: "us", name: id })),
    getAccountOliQualityCounts: async () => ({}),
    primaryOrganizationFingerprint: () => "org-fp",
    buildBucketSourceSyncRuntime: () => runtime,
    now: () => ADS_NOW,
    paidSyncConfirmationKey: () => ADS_KEY,
    getDataDoeConnections: () => [{ id: "primary", apiKey: ["ads", "key"].join("-"), accountPrefix: "", organizationFingerprint: "org-fp" }],
    // The (us, today) slot: the Ads phase opens no sync cycle -> no head, no persisted spend (the P1 precondition).
    getSyncCycleByBucketDate: async () => null,
    getSyncSourceJobs: async () => [],
    getPriorityCatalogReservation: async () => null,
    getDailyAdsCoverage: async () => ({ read: "ok", windows: [], status: "missing" }),
    runCampaignAdsBucketSlice: async (a) => {
      calls.runner.push(a);
      const creates = a.maxTotalCreates; // spend the FULL cap
      ledger.tokens += creates * 2;
      if (over.adsOutcome === "fail") return { phase: "sync", ok: false, problems: ["every batch transient after create"], creates, tokens: creates * 2 };
      return { phase: "sync", continuationRequired: true, creates, tokens: creates * 2 };
    },
  };
  // Default: the REAL supabase.js claimPaidSyncReceipt (DEFAULT_DEPS) against the emulated audit_log primary key.
  if (over.claimPaidSyncReceipt) deps.claimPaidSyncReceipt = over.claimPaidSyncReceipt;
  return { deps, calls, ledger, uid };
}
const postAds = async (env, extra = {}) => { const r = fakeRes(); await handler({ method: "POST", body: { ...ADS_BODY, ...extra } }, r, env.deps); return r; };
const adsClaims = (env, token) => RS.verifyPaidSyncConfirmation(token, { userId: env.uid, bucket: "us", sourceKey: "ads-campaign-date", refreshMode: "normal", now: ADS_NOW, key: ADS_KEY });
const b64j = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
const unb64j = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
const signPayload = (payload, key = ADS_KEY) => { const body = b64j(payload); return body + "." + createHmac("sha256", key).update(body).digest("base64url"); };

test("11. P1: replaying the START token after a spending Ads slice that ended ok:false -> 409 PAID_SYNC_TOKEN_CONSUMED with ZERO runner calls and zero spend; the fresh estimate carries NO token", async () => {
  const env = makeAdsDeps({ adsOutcome: "fail" });
  const pre = await postAds(env, { preview: true });
  assert.equal(pre.statusCode, 200, JSON.stringify(pre.body));
  const p = pre.body.preview;
  assert.equal(p.approvedMaxTokens, 10, "approved = worst case 8 + release reserve 2");
  const r1 = await postAds(env, { confirmationToken: p.confirmationToken });
  assert.equal(r1.statusCode, 200, JSON.stringify(r1.body));
  assert.equal(env.calls.runner.length, 1);
  assert.equal(env.calls.runner[0].maxTotalCreates, 4, "cap = floor((10 - 0 - 2) / 2)");
  assert.equal(r1.body.operation.ok, false, "the slice spent 8 and failed");
  for (let i = 0; i < 2; i += 1) {
    const rr = await postAds(env, { confirmationToken: p.confirmationToken });
    assert.equal(rr.statusCode, 409, JSON.stringify(rr.body));
    assert.equal(rr.body.error, "PAID_SYNC_TOKEN_CONSUMED");
    assert.match(rr.body.message, /already used; review the fresh estimate and confirm again\. Nothing was spent by this request\./);
    assert.equal(rr.body.preview && rr.body.preview.confirmationToken, null, "a refusal never hands out a token");
    assert.equal(rr.body.continuationToken, undefined);
  }
  assert.equal(env.calls.runner.length, 1, "the replays reached the runner ZERO times");
  assert.equal(env.ledger.tokens, 8, "total Ads spend under ONE confirmation stays 8 <= approved 10 (was 24 before the fix)");
  assert.equal(adsClaims(env, p.confirmationToken).adsSliceSeq, 0, "the start token is Ads step 0");
  const c1 = adsClaims(env, r1.body.continuationToken);
  assert.equal(c1.ok && c1.adsSliceSeq, 1, "the continuation issued after the slice names step 1");
  assert.equal(c1.adsSpentTokens, 8);
});

test("12. P1: replaying an OLDER continuation token (its step already consumed) is refused 409 PAID_SYNC_TOKEN_CONSUMED -- ZERO runner calls", async () => {
  const env = makeAdsDeps();
  const p = (await postAds(env, { preview: true })).body.preview;
  const r1 = await postAds(env, { confirmationToken: p.confirmationToken });
  const r2 = await postAds(env, { confirmationToken: r1.body.continuationToken });
  assert.equal(r2.statusCode, 200, JSON.stringify(r2.body));
  assert.equal(env.calls.runner.length, 2);
  const stale = await postAds(env, { confirmationToken: r1.body.continuationToken }); // step 1 again
  assert.equal(stale.statusCode, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.error, "PAID_SYNC_TOKEN_CONSUMED");
  assert.equal(env.calls.runner.length, 2, "the stale continuation reached the runner ZERO times");
  assert.equal(env.ledger.tokens, 8);
  const next = await postAds(env, { confirmationToken: r2.body.continuationToken }); // the chain head still works
  assert.equal(next.statusCode, 200, JSON.stringify(next.body));
  assert.equal(adsClaims(env, next.body.continuationToken).adsSliceSeq, 3);
});

test("13. P1: two CONCURRENT executes of the same token -> exactly ONE reaches the runner, the other is 409 PAID_SYNC_TOKEN_CONSUMED (the primary-key race)", async () => {
  const env = makeAdsDeps();
  const p = (await postAds(env, { preview: true })).body.preview;
  const [a, b] = await Promise.all([postAds(env, { confirmationToken: p.confirmationToken }), postAds(env, { confirmationToken: p.confirmationToken })]);
  const codes = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(codes, [200, 409], JSON.stringify([a.body, b.body].map((x) => x && (x.error || x.operation))));
  assert.equal([a, b].find((r) => r.statusCode === 409).body.error, "PAID_SYNC_TOKEN_CONSUMED");
  assert.equal(env.calls.runner.length, 1, "exactly one runner call");
  assert.ok(env.ledger.tokens <= p.approvedMaxTokens, "spent " + env.ledger.tokens + " <= approved " + p.approvedMaxTokens + " (was 16 of 10 before the fix)");
});

test("14. the normal continuation chain still works end to end: caps [4, 0], 8 of 10 spent, cumulative debit + aq/sp carried in each token, post-slice approval figures (P3-3)", async () => {
  const env = makeAdsDeps();
  const p = (await postAds(env, { preview: true })).body.preview;
  const r1 = await postAds(env, { confirmationToken: p.confirmationToken });
  const c1 = adsClaims(env, r1.body.continuationToken);
  const r2 = await postAds(env, { confirmationToken: r1.body.continuationToken });
  const c2 = adsClaims(env, r2.body.continuationToken);
  assert.equal(r1.statusCode, 200, JSON.stringify(r1.body));
  assert.equal(r2.statusCode, 200, JSON.stringify(r2.body));
  assert.deepEqual(env.calls.runner.map((a) => a.maxTotalCreates), [4, 0]);
  assert.equal(env.ledger.tokens, 8);
  assert.deepEqual([c1.adsSliceSeq, c1.adsSpentTokens, c2.adsSliceSeq, c2.adsSpentTokens], [1, 8, 2, 8]);
  assert.equal(c1.nonce, adsClaims(env, p.confirmationToken).nonce, "same confirmation (nonce / ceiling / expiry)");
  assert.equal(c2.approvedMaxTokens, 10);
  // P3-3: the approval returned AFTER a slice is the post-slice debit (it showed 0 after 8 spent before the fix).
  assert.deepEqual(r1.body.approval, { approvedMaxTokens: 10, debitedTokens: 8, remainingTokens: 2, releaseReserveTokens: 2 });
  assert.deepEqual(r2.body.approval, { approvedMaxTokens: 10, debitedTokens: 8, remainingTokens: 2, releaseReserveTokens: 2 });
  assert.equal(r1.body.operation.continuationRequired, true);
  assert.equal(env.calls.audit, 2, "each executed slice is audited as before");
});

test("15. a receipt claim that THROWS (or answers malformed) -> 503 PAID_SYNC_OPERATION_UNVERIFIABLE, ZERO runner calls, no token; the unclaimed step stays usable once the store recovers", async () => {
  let failures = 1;
  const store = new Set();
  const env = makeAdsDeps({
    claimPaidSyncReceipt: async ({ receiptId }) => {
      if (failures > 0) { failures -= 1; throw new Error("audit_log unreachable"); }
      if (store.has(receiptId)) return { claimed: false, reason: "consumed" };
      store.add(receiptId); return { claimed: true };
    },
  });
  const p = (await postAds(env, { preview: true })).body.preview;
  const r1 = await postAds(env, { confirmationToken: p.confirmationToken });
  assert.equal(r1.statusCode, 503, JSON.stringify(r1.body));
  assert.equal(r1.body.error, "PAID_SYNC_OPERATION_UNVERIFIABLE");
  assert.match(r1.body.message, /nothing was spent by this request/);
  assert.equal(r1.body.preview && r1.body.preview.confirmationToken, null);
  assert.equal(env.calls.runner.length, 0, "ZERO runner calls on an unprovable claim");
  const r2 = await postAds(env, { confirmationToken: p.confirmationToken });
  assert.equal(r2.statusCode, 200, "the step was never claimed -> the same token proceeds once the store answers");
  assert.equal(env.calls.runner.length, 1);
  const bad = makeAdsDeps({ claimPaidSyncReceipt: async () => undefined });
  const pb = (await postAds(bad, { preview: true })).body.preview;
  const rb = await postAds(bad, { confirmationToken: pb.confirmationToken });
  assert.equal(rb.statusCode, 503, "a malformed claim answer fails closed");
  assert.equal(bad.calls.runner.length, 0);
});

test("16. a pre-change (v2, no aq) token, a re-signed token with a MISSING / non-integer / negative aq, a start token with aq != 0 and an unsigned aq tamper are all REFUSED (428) -- ZERO receipt claims / runner calls", async () => {
  const env = makeAdsDeps();
  const p = (await postAds(env, { preview: true })).body.preview;
  const [body, mac] = p.confirmationToken.split(".");
  const payload = unb64j(body);
  assert.equal(payload.v, 3);
  assert.equal(payload.aq, 0);
  const { aq: _aq, ...noAq } = payload;
  const cases = [
    ["pre-change v2 token", signPayload({ ...noAq, v: 2 }), "version"],
    ["v3 without aq", signPayload(noAq), "malformed"],
    ["aq as a string", signPayload({ ...payload, k: "cont", aq: "1" }), "malformed"],
    ["fractional aq", signPayload({ ...payload, k: "cont", aq: 1.5 }), "malformed"],
    ["negative aq", signPayload({ ...payload, k: "cont", aq: -1 }), "malformed"],
    ["start token with aq 1", signPayload({ ...payload, aq: 1 }), "malformed"],
    ["aq tampered without re-signing", b64j({ ...payload, aq: 7 }) + "." + mac, "bad-signature"],
  ];
  const posts0 = net.auditPosts.length;
  for (const [label, token, reason] of cases) {
    const r = await postAds(env, { confirmationToken: token });
    assert.equal(r.statusCode, 428, label + ": " + JSON.stringify(r.body && r.body.error));
    assert.equal(r.body.error, "PAID_SYNC_CONFIRMATION_INVALID", label);
    assert.equal(r.body.reason, reason, label);
    assert.equal(r.body.preview && r.body.preview.confirmationToken, null, label);
  }
  assert.equal(net.auditPosts.length, posts0, "ZERO receipt claims");
  assert.equal(env.calls.runner.length, 0, "ZERO runner calls");
  assert.equal(env.calls.preflight, 0, "refused before the runtime / preflight");
});

test("17. the token primitive: a start token is always aq 0; a continuation must carry an EXPLICIT aq (no default); aq round-trips through the HMAC", () => {
  const base = { userId: "u", bucket: "us", sourceKey: "ads-campaign-date", refreshMode: "normal", approvedMaxTokens: 10, asOf: "2026-09-25", key: ADS_KEY, now: 1000 };
  const op = { key: "us/2026-09-26", cycleId: "", baselineTokens: 0 };
  const start = RS.issuePaidSyncConfirmation({ ...base, operation: op });
  const vs = RS.verifyPaidSyncConfirmation(start.token, { ...base, now: 2000 });
  assert.equal(vs.ok && vs.adsSliceSeq, 0);
  assert.equal(RS.issuePaidSyncConfirmation({ ...base, operation: { ...op, adsSliceSeq: 1 } }), null, "a start token can never be minted past step 0");
  const contArgs = { ...base, kind: "cont", nonce: vs.nonce, issuedAt: vs.issuedAt, expiresAtMs: vs.expiresAtMs };
  assert.equal(RS.issuePaidSyncConfirmation({ ...contArgs, operation: { ...op, adsSpentTokens: 8 } }), null, "a continuation WITHOUT an explicit aq is refused (never defaults to 0)");
  assert.equal(RS.issuePaidSyncConfirmation({ ...contArgs, operation: { ...op, adsSpentTokens: 8, adsSliceSeq: -1 } }), null);
  assert.equal(RS.issuePaidSyncConfirmation({ ...contArgs, operation: { ...op, adsSpentTokens: 8, adsSliceSeq: "2" } }), null);
  const cont = RS.issuePaidSyncConfirmation({ ...contArgs, operation: { ...op, adsSpentTokens: 8, adsSliceSeq: 2 } });
  const vc = RS.verifyPaidSyncConfirmation(cont.token, { ...base, now: 3000 });
  assert.deepEqual([vc.ok, vc.kind, vc.adsSliceSeq, vc.adsSpentTokens, vc.nonce, vc.expiresAtMs], [true, "cont", 2, 8, vs.nonce, vs.expiresAtMs]);
});

test("18. paidSyncAdsReceiptId: deterministic, a canonical lowercase UUIDv5-shaped id of sha256('paid-sync-ads-receipt|v1|' + nonce + '|' + seq), different per (nonce, seq); malformed input throws", () => {
  const id = RS.paidSyncAdsReceiptId({ nonce: "abcdefghijkl", seq: 0 });
  assert.equal(id, RS.paidSyncAdsReceiptId({ nonce: "abcdefghijkl", seq: 0 }), "deterministic");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "version 5 + RFC 4122 variant");
  const h = createHash("sha256").update("paid-sync-ads-receipt|v1|abcdefghijkl|0").digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  assert.equal(id, [x.slice(0, 8), x.slice(8, 12), x.slice(12, 16), x.slice(16, 20), x.slice(20)].join("-"), "the exact documented derivation");
  const ids = new Set([id, RS.paidSyncAdsReceiptId({ nonce: "abcdefghijkl", seq: 1 }), RS.paidSyncAdsReceiptId({ nonce: "abcdefghijkm", seq: 0 }), RS.paidSyncAdsReceiptId({ nonce: "abcdefghijkm", seq: 1 })]);
  assert.equal(ids.size, 4, "different per (nonce, seq)");
  for (const bad of [{ nonce: "short", seq: 0 }, { nonce: "abcdefghijkl", seq: -1 }, { nonce: "abcdefghijkl", seq: 1.5 }, { nonce: "abcdefghijkl", seq: "0" }, { nonce: null, seq: 0 }, {}]) {
    assert.throws(() => RS.paidSyncAdsReceiptId(bad), /PAID_SYNC_RECEIPT_ID_INPUT_INVALID/);
  }
});

test("19. claimPaidSyncReceipt (REAL, emulated PostgREST): insert-if-absent with the explicit id; 409/23505 -> consumed; a 409 carrying another SQLSTATE (23503), a 500 and a network failure THROW; a malformed id throws BEFORE any request", async () => {
  const id = RS.paidSyncAdsReceiptId({ nonce: "claimtest01", seq: 0 });
  const posts0 = net.auditPosts.length;
  const first = await claimPaidSyncReceipt({ receiptId: id, actorUserId: null, action: "source.sync.paid-ads-receipt", target: { aq: 0 } });
  assert.deepEqual(first, { claimed: true });
  const sent = net.auditPosts[net.auditPosts.length - 1];
  assert.deepEqual(sent.body, { id, actor_user_id: null, action: "source.sync.paid-ads-receipt", target: { aq: 0 } }, "the explicit primary key is sent");
  assert.equal(sent.headers.Prefer, "return=minimal");
  assert.deepEqual(await claimPaidSyncReceipt({ receiptId: id, action: "source.sync.paid-ads-receipt" }), { claimed: false, reason: "consumed" }, "a duplicate id (409 + 23505) is consumed");
  const id2 = RS.paidSyncAdsReceiptId({ nonce: "claimtest01", seq: 1 });
  net.nextAudit = () => fakeFetchRes(409, null);
  assert.deepEqual(await claimPaidSyncReceipt({ receiptId: id2, action: "a" }), { claimed: false, reason: "consumed" }, "a bare 409 without a SQLSTATE is a conflict");
  net.nextAudit = () => fakeFetchRes(400, { code: "23505", message: "dup" });
  assert.deepEqual(await claimPaidSyncReceipt({ receiptId: id2, action: "a" }), { claimed: false, reason: "consumed" }, "code 23505 is a conflict whatever the status");
  net.nextAudit = () => fakeFetchRes(409, { code: "23503", message: "fk" });
  await assert.rejects(() => claimPaidSyncReceipt({ receiptId: id2, action: "a" }), /Supabase request failed \(409\)/, "a foreign-key 409 is NOT 'already used'");
  net.nextAudit = () => fakeFetchRes(500, { message: "boom" });
  await assert.rejects(() => claimPaidSyncReceipt({ receiptId: id2, action: "a" }), /Supabase request failed \(500\)/);
  net.nextAudit = () => { throw new TypeError("fetch failed"); };
  await assert.rejects(() => claimPaidSyncReceipt({ receiptId: id2, action: "a" }), /fetch failed/);
  const postsBeforeBad = net.auditPosts.length;
  for (const badId of [id.toUpperCase(), "not-a-uuid", "", null, 42, id + "0"]) {
    await assert.rejects(() => claimPaidSyncReceipt({ receiptId: badId, action: "a" }), (e) => e.code === "PAID_SYNC_RECEIPT_ID_INVALID");
  }
  await assert.rejects(() => claimPaidSyncReceipt({ receiptId: id2, action: "" }), (e) => e.code === "PAID_SYNC_RECEIPT_ACTION_INVALID");
  assert.equal(net.auditPosts.length, postsBeforeBad, "malformed input never reaches the network");
  assert.equal(net.auditPosts.length - posts0, 7);
});

test("20. the receipt row records the step's scope + the spend BEFORE it (no token, MAC or secret) and is claimed AFTER the as-of / operation / debit / reserve checks and BEFORE the runner (source order)", async () => {
  const env = makeAdsDeps();
  const p = (await postAds(env, { preview: true })).body.preview;
  const r1 = await postAds(env, { confirmationToken: p.confirmationToken });
  const nonce = adsClaims(env, p.confirmationToken).nonce;
  const row = net.audit.get(RS.paidSyncAdsReceiptId({ nonce, seq: 0 }));
  assert.ok(row, "the step-0 receipt exists under its deterministic id");
  assert.equal(row.action, "source.sync.paid-ads-receipt");
  assert.equal(row.actor_user_id, env.uid);
  assert.deepEqual(row.target, { bucket: "us", sourceKey: "ads-campaign-date", asOf: "2026-09-25", operationKey: "us/" + ADS_TODAY, aq: 0, approvedMaxTokens: 10, adsSpentTokensBefore: 0, debitedTokensBefore: 0, maxTotalCreates: 4 });
  const rowText = JSON.stringify(row);
  for (const t of [p.confirmationToken, r1.body.continuationToken]) for (const part of t.split(".")) assert.ok(!rowText.includes(part), "no token part in the receipt");
  const c1Row = net.audit.get(RS.paidSyncAdsReceiptId({ nonce, seq: 1 }));
  assert.equal(c1Row, undefined, "step 1 is claimed only when its token is presented");
  const { readFileSync } = await import("node:fs");
  const s = readFileSync(new URL("../api/admin/sources.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const claimAt = s.indexOf('depOf(deps, "claimPaidSyncReceipt")(');
  const runAt = s.indexOf("const ads = await runCampaignAdsBucketSlice(");
  assert.ok(claimAt > 0 && runAt > claimAt, "the claim precedes the runner");
  assert.ok(s.indexOf("await paidSyncDebit({ claims: paidConfirmation") < claimAt && s.indexOf("releaseReserveTokens = (await releaseCatalogExposure(") < claimAt && s.indexOf("paidConfirmation.asOf !== paidCtx.asOf") < claimAt, "after the as-of / debit / reserve checks");
  assert.ok(s.indexOf('"PAID_SYNC_TOKEN_CONSUMED"') > claimAt && s.indexOf('"PAID_SYNC_TOKEN_CONSUMED"') < runAt, "the consumed refusal returns before the runner");
});

test("21. P3-5: verified CONTINUATION polls draw from their own capped budget (60 / 10 min) -- 40+ polls never 429 mid-run, while previews / start executes keep the original 30 / 10 min window", async () => {
  const env = makeAdsDeps();
  const p = (await postAds(env, { preview: true })).body.preview; // main 1
  let r = await postAds(env, { confirmationToken: p.confirmationToken }); // main 2 (a START token)
  assert.equal(r.statusCode, 200);
  for (let poll = 1; poll <= 60; poll += 1) {
    r = await postAds(env, { confirmationToken: r.body.continuationToken });
    assert.equal(r.statusCode, 200, "continuation poll " + poll + ": " + JSON.stringify(r.body && r.body.error));
  }
  assert.equal(adsClaims(env, r.body.continuationToken).adsSliceSeq, 61);
  const over = await postAds(env, { confirmationToken: r.body.continuationToken });
  assert.equal(over.statusCode, 429, "the continuation budget is itself capped");
  for (let i = 3; i <= 30; i += 1) assert.equal((await postAds(env, { preview: true })).statusCode, 200, "preview " + i);
  assert.equal((await postAds(env, { preview: true })).statusCode, 429, "the 31st preview / start in 10 min is still refused");
  assert.ok(env.ledger.tokens <= 10, "and the spend never left the approval: " + env.ledger.tokens);
});

test("22. P3-6: the paused-FBA 409, a runtime pre-I/O refusal 409 and the FBA 423 contention carry a readable error + message (the UI shows 'error: message'); nothing else about them changed", async () => {
  const { readFileSync } = await import("node:fs");
  const s = readFileSync(new URL("../api/admin/sources.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(s, /error: "SOURCE_PAUSED", message: "This source is paused; resume it before syncing\. Nothing was spent by this request\."/);
  assert.equal((s.match(/refusal: rollup, \.\.\.refusalText\(rollup\)/g) || []).length, 1);
  assert.equal((s.match(/refusal: result, \.\.\.refusalText\(result\)/g) || []).length, 1);
  assert.equal((s.match(/res\.status\(423\)\.json\(\{ operation: \{ phase: "contention"[^\n]*error: "CONTROL_LEASE_HELD", message: CONTENTION_MESSAGE/g) || []).length, 2, "both 423 responses");
  assert.equal((s.match(/status: "CONTROL_LEASE_LOST"[^\n]*error: "CONTROL_LEASE_LOST", message: CONTENTION_MESSAGE/g) || []).length, 2, "both 409 lease-lost responses");
  // Behavioural: a runtime pre-I/O refusal of a non-orchestrated card now reads as "CODE: message".
  const { deps } = makeDeps();
  deps.getDashboardAccess = async () => ({ userId: "p36-admin" });
  deps.getAccountDirectoryRows = async () => [{ account_id: "X1", marketplace_country_code: "US", sync_bucket: "us", name: "X1", currency: "USD" }];
  deps.getSourceCoverageWindows = async () => ({ read: "ok", windows: [{ from: "2025-01-01", to: "2026-09-25" }] });
  deps.getSourceSnapshot = async () => ({ read: "ok", snapshot: null });
  const runtime = deps.buildBucketSourceSyncRuntime();
  runtime.preflightEvidence = async () => ({ today: "2026-09-26", evidence: {} });
  runtime.run = async () => ({ refused: true, code: "SOURCE_ACTION_TEST_REFUSED", message: "Refused for the test." });
  const pre = fakeRes();
  await handler({ method: "POST", body: { bucket: "us", preview: true } }, pre, deps);
  assert.equal(pre.statusCode, 200, JSON.stringify(pre.body));
  const res = fakeRes();
  await handler({ method: "POST", body: { bucket: "us", confirmationToken: pre.body.preview.confirmationToken } }, res, deps);
  assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  assert.equal(res.body.error, "SOURCE_ACTION_TEST_REFUSED");
  assert.equal(res.body.message, "Refused for the test. Nothing was spent by this request.");
  assert.equal(res.body.refusal.code, "SOURCE_ACTION_TEST_REFUSED", "the typed refusal is still attached");
});

test("23. P3-2 / P2 preview honesty: the Ads estimate states that pagination creates are outside the worst case but capped (a refused page leaves the window uncovered); the FBA estimate states the plan-cost approval check + one create per request hash", async () => {
  const env = makeAdsDeps();
  const pa = (await postAds(env, { preview: true })).body.preview;
  assert.ok(pa.estimate.assumptions.some((a) => /Pagination creates beyond the planned exports are not included in the worst case; the approval caps them .* a refused page leaves the window uncovered, never complete\./.test(a)), JSON.stringify(pa.estimate.assumptions));
  const { readFileSync } = await import("node:fs");
  const s = readFileSync(new URL("../api/admin/sources.js", import.meta.url), "utf8");
  assert.match(s, /The approval is checked against the cache-aware PLAN cost before the fba-plan operation runs .* creates are bounded to one per canonical request hash, with no separate per-create token ceiling/);
});

test("25. round-2 P3-1: an UNPROVABLE Ads spend report (NaN / Infinity / negative / fractional / string / missing creates or tokens) closes the confirmation -- 502 PAID_SYNC_RESULT_UNPROVABLE, NO continuation token, the step's receipt stays consumed (a replay is 409), never a 0 debit", async () => {
  const BAD = [{ creates: NaN, tokens: 8 }, { creates: 4, tokens: Infinity }, { creates: -1, tokens: 0 }, { creates: 1.5, tokens: 3 }, { creates: "4", tokens: 8 }, { tokens: 8 }, { creates: 4 }];
  for (const bad of BAD) {
    const env = makeAdsDeps();
    env.deps.runCampaignAdsBucketSlice = async (a) => { env.calls.runner.push(a); return { phase: "sync", continuationRequired: true, ...bad }; };
    const pre = await postAds(env, { preview: true });
    assert.equal(pre.statusCode, 200, JSON.stringify(pre.body));
    const r1 = await postAds(env, { confirmationToken: pre.body.preview.confirmationToken });
    assert.equal(r1.statusCode, 502, JSON.stringify(bad) + " -> " + JSON.stringify(r1.body));
    assert.equal(r1.body.error, "PAID_SYNC_RESULT_UNPROVABLE");
    assert.match(r1.body.message, /unprovable spend/);
    assert.equal(r1.body.continuationToken, undefined, "no continuation token after an unprovable spend");
    assert.equal(env.calls.runner.length, 1);
    const rr = await postAds(env, { confirmationToken: pre.body.preview.confirmationToken });
    assert.equal(rr.statusCode, 409, "the consumed step is not reusable: " + JSON.stringify(rr.body));
    assert.equal(rr.body.error, "PAID_SYNC_TOKEN_CONSUMED");
    assert.equal(env.calls.runner.length, 1, "the replay never reaches the runner");
  }
});

test("24. the whole suite made ZERO network requests other than the emulated audit_log inserts (no DataDoe, no database)", () => {
  const other = net.calls.filter((c) => !/^POST [^ ]*\/rest\/v1\/audit_log$/.test(c));
  assert.deepEqual(other, []);
});

async function main() {
  out("api/admin/sources boundary proof suite");
  ({ handler } = await import("../api/admin/sources.js"));
  ({ isAdsRegistryKeyRetired } = await import("../lib/server/active-ads-source.js"));
  RS = await import("../lib/server/report-store.js");
  ({ claimPaidSyncReceipt } = await import("../lib/server/supabase.js"));
  let failures = 0;
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { failures += 1; out("FAIL  " + t.name); out(String(e && e.stack ? e.stack : e)); }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
}

main();
