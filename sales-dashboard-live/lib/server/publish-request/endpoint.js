// "Publish from saved data" -- the dashboard endpoint logic (api/datadoe.js action=publish-request). A SHORT request:
// it authorizes the signed-in user for the EXACT scope, reads the control row, answers 'Already current' from the
// dashboard-served row when that is proven, and otherwise creates (or joins) ONE durable request -- it never builds,
// derives, locks or publishes anything. Every collaborator is injected (api/datadoe.js wires the real ones).
//
//   GET  ?action=publish-request&report=brand-view&ids=<account>&brand=<exact brand>&asOf=YYYY-MM-DD
//        -> { supported, enabled, reason?, request: <public view of the newest request for this exact scope + date> | null,
//             executorOnline }   (every user authorized for the scope sees the same request)
//   POST (same query) -> 200 { state:'already_current', served } | 202 { state:'queued'|'publishing', request, deduplicated }
//        | 409 { state:'not-enabled'|'as-of-rolled'|'rate-limited'|'queue-full', message } | 4xx
// AUTHORIZATION (fail closed, before any read of the scope): the account grant (assertAccountAccess); for a
// SELECTED_BRANDS grant the trusted brand scope must permit EXACTLY the requested brand (never silently rewritten for
// a write); the brand must be in the account's saved brand directory; the date must be the one the dashboard serves
// today (marketplaceToday of the account's TRUSTED country). 7-bit ASCII, LF.

import { canonicalScope, isSavedDataPublishReport, STATUS_TEXT, REQUEST_STATUS, ACTIVE_STATUSES } from "./contract.js";

const S = (v) => (v == null ? "" : String(v));
// Above the executor's longest silence (a 120 s capped sleep, a 300 s job renews every 40 s, the beat is 60 s-throttled).
const EXECUTOR_ONLINE_MS = 5 * 60 * 1000;

/** The request as any authorized viewer may see it (no other user's identity, no internal tokens). */
export function publicRequestView(r, { userId = null } = {}) {
  if (!r) return null;
  const result = r.result && typeof r.result === "object" ? r.result : {};
  const served = result.served && typeof result.served === "object" ? result.served : null;
  const reason = S(r.reason).replace(/[^\x20-\x7e]/g, "").slice(0, 240) || null;
  return {
    id: S(r.id), status: S(r.status), statusText: STATUS_TEXT[S(r.status)] || S(r.status), reason,
    waiting: S(r.status) === REQUEST_STATUS.QUEUED && reason && reason.startsWith("waiting:") ? reason.slice(8) : null,
    asOf: S(r.as_of).slice(0, 10), requestCount: Number(r.request_count) || 1, attempts: Number(r.attempts) || 0,
    createdAt: r.created_at || null, updatedAt: r.updated_at || null, finishedAt: r.finished_at || null,
    requestedByMe: !!userId && S(r.requested_by) === S(userId),
    served: served ? { sourceRefreshedAt: served.sourceRefreshedAt || null, salesLatestDate: served.salesLatestDate || null } : null,
  };
}

const bad = (status, error, extra = {}) => ({ status, json: { error, ...extra } });

/**
 * The brand check for a WRITE request, over the REAL trusted scope resolver (report-authorization.js): admin / ALL_BRANDS
 * -> ok; SELECTED_BRANDS -> ok ONLY when the resolver names EXACTLY the requested brand (never the resolver's own
 * substitute, never ALL_PERMITTED). api/datadoe.js wires resolveUserReportScope + getTrustedAccountBrands + brandKey.
 */
export function makeBrandAuthorizer({ resolveUserReportScope, getTrustedBrands, brandKey, BrandAccessError }) {
  return async ({ access, accountId, brand, reportKey }) => {
    try {
      const scope = await resolveUserReportScope({ access, requestedAccountId: accountId, requestedBrand: brand, action: reportKey, getTrustedBrands });
      if (!scope || scope.restricted !== true) return { ok: true };
      if (scope.brandScope !== "NAMED" || scope.requestedBrandKey !== brandKey(brand)) return { ok: false, status: 403, error: "You do not have access to this brand." };
      // The serve answers a restricted user with the TRUSTED display of the permitted brand (api/datadoe.js rewrites
      // req.query.brand to it): publishing any other spelling would verify a row this user's page never reads.
      const display = scope.permittedBrandDisplays instanceof Map ? scope.permittedBrandDisplays.get(scope.requestedBrandKey) : null;
      if (display != null && display !== brand) return { ok: false, status: 409, error: "This brand is saved under a different name for your access; it cannot be published from here." };
      return { ok: true };
    } catch (e) {
      if (BrandAccessError && e instanceof BrandAccessError) return { ok: false, status: e.status, error: e.message };
      throw e;
    }
  };
}

/** Authorize + canonicalize the scope. -> { ok:true, scope } | { ok:false, status, json } */
async function authorizeScope({ query, access, deps }) {
  const reportKey = S(query.report);
  if (!isSavedDataPublishReport(reportKey)) return { ok: false, ...bad(400, "Publishing from saved data is not supported for this report.", { state: "not-supported" }) };
  const ids = S(query.ids).split(",").map((x) => x.trim()).filter(Boolean);
  if (ids.length !== 1) return { ok: false, ...bad(400, "Publishing from saved data needs exactly one account.") };
  const c = canonicalScope({ reportKey, accountId: ids[0], brand: query.brand, asOf: query.asOf });
  if (!c.ok) return { ok: false, ...bad(400, "Invalid publish scope (" + c.code + ").") };
  const { accountId, brand, asOf } = c.scope;
  try { deps.assertAccountAccess(access, [accountId]); }
  catch (e) { return { ok: false, ...bad(Number(e && e.status) || 403, "You do not have access to this account.") }; }
  const brandOk = await deps.authorizeBrand({ access, accountId, brand, reportKey });
  if (!brandOk || brandOk.ok !== true) return { ok: false, ...bad(Number(brandOk && brandOk.status) || 403, S(brandOk && brandOk.error) || "You do not have access to this brand.") };
  const dir = await deps.brandInDirectory({ accountId, brand });
  if (dir && dir.unavailable) return { ok: false, ...bad(503, "The account's saved brand list is unavailable right now. Try again shortly.") };
  if (!dir || dir.ok !== true) return { ok: false, ...bad(400, "This brand is not in this account's saved data.") };
  const country = S(await deps.accountCountry(accountId)).trim();
  if (!country) return { ok: false, ...bad(409, "This account has no saved marketplace yet.", { state: "missing_evidence" }) };
  const today = deps.marketplaceToday(country, new Date(deps.now()));
  if (asOf !== today) return { ok: false, ...bad(409, "The report date has changed. Reload the page to publish today's report.", { state: "as-of-rolled", asOf: today }) };
  return { ok: true, scope: c.scope };
}

function controlState(control, scope) {
  if (!control) return { enabled: false, reason: "control-unavailable" };
  if (control.enabled !== true) return { enabled: false, reason: "disabled" };
  const keys = Array.isArray(control.report_keys) ? control.report_keys.map(S) : [];
  if (!keys.includes(scope.reportKey)) return { enabled: false, reason: "report-not-enabled" };
  const canary = Array.isArray(control.canary_scope_keys) ? control.canary_scope_keys.map(S) : [];
  if (canary.length && !canary.includes(scope.scopeKey)) return { enabled: false, reason: "scope-not-enabled" };
  return { enabled: true, reason: null };
}
const executorOnline = (control, nowMs) => !!(control && control.worker_seen_at && nowMs - Date.parse(S(control.worker_seen_at)) < EXECUTOR_ONLINE_MS);

const NOT_ENABLED_TEXT = {
  disabled: "Publishing from saved data is switched off.",
  "report-not-enabled": "Publishing from saved data is not enabled for this report yet.",
  "scope-not-enabled": "Publishing from saved data is enabled only for a test brand right now.",
  "control-unavailable": "Publishing from saved data is unavailable right now.",
};

export async function handlePublishRequestAction({ method, query = {}, access, deps }) {
  const m = S(method).toUpperCase();
  if (m !== "GET" && m !== "POST") return bad(405, "Method not allowed.");
  if (!isSavedDataPublishReport(S(query.report))) return bad(400, "Publishing from saved data is not supported for this report.", { state: "not-supported" });
  // CHEAP FIRST (every Brand View page load reads this status): ONE control-row read. While the feature is off for
  // this report the answer is scope-independent ({ enabled:false }), so no authorization reads are spent on it and
  // nothing about the scope is revealed. Everything scope-specific below runs only after full authorization.
  let control = null;
  try { control = await deps.getControl(); } catch { control = null; }
  const off = controlState(control, { reportKey: S(query.report), scopeKey: null });
  if (!off.enabled && off.reason !== "scope-not-enabled") {
    return m === "GET"
      ? { status: 200, json: { supported: true, enabled: false, reason: off.reason, message: NOT_ENABLED_TEXT[off.reason] || null, request: null, executorOnline: false } }
      : { status: 409, json: { state: "not-enabled", reason: off.reason, message: NOT_ENABLED_TEXT[off.reason] || "Not enabled." } };
  }
  const auth = await authorizeScope({ query, access, deps });
  if (!auth.ok) return { status: auth.status, json: auth.json };
  const scope = auth.scope;
  const cs = controlState(control, scope);
  const nowMs = deps.now();
  const online = executorOnline(control, nowMs);

  if (m === "GET") {
    let latest = null;
    try { latest = await deps.getLatestForScope({ reportKey: scope.reportKey, scopeKey: scope.scopeKey, asOf: scope.asOf }); } catch { latest = null; }
    const view = publicRequestView(latest, { userId: access && access.userId });
    const state = S(control && control.worker_state);
    // A queued request with no reason of its own shows what the executor is waiting for (its pre-claim gates).
    if (view && view.status === REQUEST_STATUS.QUEUED && !view.waiting && state.startsWith("paused:")) view.waiting = state.slice(7).replace(/[^ -~]/g, "").slice(0, 100);
    return { status: 200, json: { supported: true, enabled: cs.enabled, reason: cs.reason, message: cs.enabled ? null : NOT_ENABLED_TEXT[cs.reason] || null, request: view, executorOnline: online } };
  }

  // POST
  if (!cs.enabled) return { status: 409, json: { state: "not-enabled", reason: cs.reason, message: NOT_ENABLED_TEXT[cs.reason] || "Not enabled." } };
  if (!S(access && access.userId)) return bad(401, "Sign in again to publish.");
  // 'Already current' is answered from the dashboard-served row itself (the serve's own freshness rule); anything
  // else -- including an unknown -- is left to the executor, which re-proves it from saved evidence.
  let cur = null;
  try { cur = await deps.currency({ accountId: scope.accountId, brand: scope.brand, asOf: scope.asOf }); } catch { cur = null; }
  if (cur && cur.current === true) {
    return { status: 200, json: { state: REQUEST_STATUS.ALREADY_CURRENT, statusText: STATUS_TEXT[REQUEST_STATUS.ALREADY_CURRENT], served: cur.served ? { sourceRefreshedAt: cur.served.sourceRefreshedAt, salesLatestDate: cur.served.salesLatestDate } : null } };
  }
  let r;
  try { r = await deps.enqueue({ reportKey: scope.reportKey, scopeKey: scope.scopeKey, accountId: scope.accountId, brand: scope.brand, asOf: scope.asOf, requestedBy: S(access.userId) }); }
  catch { return { status: 503, json: { state: "unavailable", message: "Could not record the request. Try again shortly." } }; }
  const outcome = S(r && r.outcome);
  if (outcome === "enqueued" || outcome === "deduplicated") {
    let row = null;
    try { row = await deps.getById(S(r.id)); } catch { row = null; }
    const view = publicRequestView(row, { userId: access.userId }) || { id: S(r.id), status: S(r.status) || REQUEST_STATUS.QUEUED, statusText: STATUS_TEXT[S(r.status) || REQUEST_STATUS.QUEUED] };
    return { status: 202, json: { state: ACTIVE_STATUSES.includes(view.status) ? view.status : REQUEST_STATUS.QUEUED, deduplicated: outcome === "deduplicated", request: view, executorOnline: online } };
  }
  if (outcome === "rate-limited") return { status: 429, json: { state: "rate-limited", message: "Too many publish requests in the last hour. Try again later." } };
  if (outcome === "queue-full") return { status: 409, json: { state: "queue-full", message: "The publish queue is full right now. Try again shortly." } };
  return { status: 409, json: { state: "not-enabled", reason: outcome || "disabled", message: NOT_ENABLED_TEXT[outcome] || "Not enabled." } };
}
