// "Publish from saved data" -- the PURE contract shared by the dashboard endpoint (api/datadoe.js), the executor
// (scripts/worker/publish-request-worker.mjs) and the tests: which reports support a user-requested zero-export
// publication, the exact scope identity of a request, the user-facing states, and the mapping from what the EXISTING
// route release reported for the one requested unit to the request's durable outcome.
//
// A report is publishable from saved data ONLY when the report registry (report-materialization-registry.js
// `savedDataPublish`) names a recovery route here AND that route's executor is implemented + tested
// (SAVED_DATA_PUBLISH_ROUTES). Everything else fails closed ('report-not-supported'). The reason vocabulary is NOT
// re-invented: a unit's (state, reason) goes through the recovery classifier (lib/server/recovery/classify.js
// classifyReason, route-cli kind) and only its CLASS is mapped to a request outcome here. No I/O. 7-bit ASCII, LF.

import { classifyReason, CLASSES } from "../recovery/classify.js";
import { SAVED_DATA_PUBLISH_ROUTES } from "./routes.js";

export { SAVED_DATA_PUBLISH_ROUTES };
const S = (v) => (v == null ? "" : String(v));

export const REQUEST_STATUS = Object.freeze({
  QUEUED: "queued",
  PUBLISHING: "publishing",
  PUBLISHED: "published",
  ALREADY_CURRENT: "already_current",
  MISSING_EVIDENCE: "missing_evidence",
  FAILED: "failed",
});
export const ACTIVE_STATUSES = Object.freeze([REQUEST_STATUS.QUEUED, REQUEST_STATUS.PUBLISHING]);
export const TERMINAL_STATUSES = Object.freeze([REQUEST_STATUS.PUBLISHED, REQUEST_STATUS.ALREADY_CURRENT, REQUEST_STATUS.MISSING_EVIDENCE, REQUEST_STATUS.FAILED]);

// Bounds shared with the migration (20260936_publish_requests.sql).
export const ACCOUNT_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;
export const MAX_BRAND_CHARS = 200;
export const MAX_SCOPE_KEY_CHARS = 400;
export const MAX_REASON_CHARS = 240;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True when `reportKey` has a tested saved-data publish executor. */
export function isSavedDataPublishReport(reportKey) {
  return Object.prototype.hasOwnProperty.call(SAVED_DATA_PUBLISH_ROUTES, S(reportKey));
}

/**
 * Validate + canonicalize a request scope (PURE). -> { ok:true, scope:{ reportKey, accountId, brand, asOf, scopeKey } }
 * | { ok:false, code }. The brand is the EXACT directory string (a Brand View unit is keyed by the exact brand); only
 * surrounding whitespace is refused, never silently trimmed into another brand.
 */
export function canonicalScope({ reportKey, accountId, brand, asOf } = {}) {
  const rk = S(reportKey);
  if (!isSavedDataPublishReport(rk)) return { ok: false, code: "report-not-supported" };
  const acct = S(accountId);
  if (!ACCOUNT_ID_RE.test(acct)) return { ok: false, code: "account-invalid" };
  const b = S(brand);
  if (b === "" || b !== b.trim() || b.length > MAX_BRAND_CHARS || /[\u0000-\u001f]/.test(b)) return { ok: false, code: "brand-invalid" };
  const d = S(asOf);
  if (!DATE_RE.test(d) || Number.isNaN(Date.parse(d + "T00:00:00Z"))) return { ok: false, code: "as-of-invalid" };
  const scopeKey = rk + "|" + acct + "|" + b;
  if (scopeKey.length > MAX_SCOPE_KEY_CHARS) return { ok: false, code: "scope-too-long" };
  return { ok: true, scope: { reportKey: rk, accountId: acct, brand: b, asOf: d, scopeKey } };
}

/** A bounded machine reason (the migration caps reason at 240 chars; never a payload / message body). */
export function boundedReason(reason) {
  return S(reason).replace(/[^\x20-\x7e]/g, "").slice(0, MAX_REASON_CHARS) || null;
}

// Request outcome per recovery CLASS for the ONE requested unit. 'verify' = the release reported a publish or current:
// the executor's own served read-back decides (published / already_current) -- never the release's word alone.
// 'release' = contention (another publisher holds the global lease): back to the queue WITHOUT consuming an attempt.
const CLASS_OUTCOME = Object.freeze({
  [CLASSES.CURRENT]: { finish: "verify" },
  [CLASSES.PUBLISHED_UNVERIFIED]: { finish: "verify" },
  [CLASSES.MISSING_EVIDENCE]: { finish: REQUEST_STATUS.MISSING_EVIDENCE },
  [CLASSES.NOT_APPLICABLE]: { finish: REQUEST_STATUS.MISSING_EVIDENCE },
  [CLASSES.CONTENTION]: { finish: "release", retrySeconds: 120 },
  [CLASSES.NOT_ATTEMPTED]: { finish: "release", retrySeconds: 120 },
  [CLASSES.EVIDENCE_ADVANCED]: { finish: "retry", retrySeconds: 60 },
  [CLASSES.DEPENDENCY]: { finish: "retry", retrySeconds: 300 },
  [CLASSES.CURRENT_UNSERVED]: { finish: "retry", retrySeconds: 120 },
  [CLASSES.STALE]: { finish: "retry", retrySeconds: 120 },
  [CLASSES.TIMEOUT]: { finish: "retry", retrySeconds: 180 },
  [CLASSES.TRANSPORT]: { finish: "retry", retrySeconds: 120 },
  [CLASSES.READBACK_MISMATCH]: { finish: "retry", retrySeconds: 120 },
  [CLASSES.RUN_FAILED]: { finish: "retry", retrySeconds: 300 },
  [CLASSES.AWAIT_TIMEOUT]: { finish: "retry", retrySeconds: 300 },
  [CLASSES.CAPACITY_EXCEEDED]: { finish: REQUEST_STATUS.FAILED },
  [CLASSES.SERVED_ROW_PREEMPTED]: { finish: REQUEST_STATUS.FAILED },
  [CLASSES.ROUTE_NOT_ACTIVATED]: { finish: REQUEST_STATUS.FAILED },
  [CLASSES.CONFIG_ALERT]: { finish: REQUEST_STATUS.FAILED },
  [CLASSES.SUPERSEDED_NEWER_LIVE]: { finish: "verify-or-fail" },
  [CLASSES.TERMINAL_CYCLE]: { finish: REQUEST_STATUS.FAILED },
  [CLASSES.INTEGRITY]: { finish: REQUEST_STATUS.FAILED },
  [CLASSES.ZERO_EXPORT_VIOLATION]: { finish: REQUEST_STATUS.FAILED },
  [CLASSES.UNKNOWN]: { finish: "retry", retrySeconds: 600 },
});

/**
 * Map the requested unit's (state, reason) as the reconciler reported it to the request outcome (PURE).
 * -> { finish: 'verify' | 'verify-or-fail' | 'retry' | 'release' | 'missing_evidence' | 'failed', cls, reason, retrySeconds }
 */
// A no-cost 'release' is ONLY for "another operation holds the global control lease" (typed CONTROL_LEASE_HELD by the
// control package, or a held derive lease): nothing of ours failed. Every other contention / not-attempted reason (an
// apply that did not commit, a pending capability, a derive that never fits the start cutoff) is a bounded RETRY, so it
// cannot loop until the date rolls.
const LEASE_HELD_RE = /CONTROL_LEASE_HELD|(^|:)claim-held/;
export function outcomeForUnit(state, reason) {
  const v = classifyReason(S(state), S(reason), { routeKind: "route-cli" });
  const cls = v && v.cls ? v.cls : CLASSES.UNKNOWN;
  let o = CLASS_OUTCOME[cls] || { finish: "retry", retrySeconds: 600 };
  if (o.finish === "release" && !LEASE_HELD_RE.test(S(reason))) o = { finish: "retry", retrySeconds: 120 };
  return { finish: o.finish, cls, reason: boundedReason((v && v.reason) || reason || S(state)), retrySeconds: o.retrySeconds || 0 };
}

/**
 * The outcome when the reconciler returned NO unit for the requested brand (PURE): the account-level record's own typed
 * reason decides (an ineligible account = missing evidence; an empty unit list = the brand is not in the account's
 * saved brand directory; a whole-run failure = retry).
 */
export function outcomeForMissingUnit({ runOk, runCode, accountRecord, unitsEmpty } = {}) {
  if (runOk === false && !accountRecord) return { finish: "retry", cls: CLASSES.RUN_FAILED, reason: boundedReason("run-failed:" + S(runCode)), retrySeconds: 300 };
  if (unitsEmpty) return { finish: REQUEST_STATUS.MISSING_EVIDENCE, cls: CLASSES.MISSING_EVIDENCE, reason: "brand-not-in-saved-directory", retrySeconds: 0 };
  const reports = accountRecord && accountRecord.reports && typeof accountRecord.reports === "object" ? Object.values(accountRecord.reports) : [];
  const r = reports[0];
  if (r && r.state) return outcomeForUnit(r.state, r.reason);
  return { finish: REQUEST_STATUS.MISSING_EVIDENCE, cls: CLASSES.MISSING_EVIDENCE, reason: "brand-not-in-saved-directory", retrySeconds: 0 };
}

// The user-facing sentence for each state (the UI adds the reason code in a secondary line).
export const STATUS_TEXT = Object.freeze({
  [REQUEST_STATUS.QUEUED]: "Queued",
  [REQUEST_STATUS.PUBLISHING]: "Publishing",
  [REQUEST_STATUS.PUBLISHED]: "Published and verified",
  [REQUEST_STATUS.ALREADY_CURRENT]: "Already current",
  [REQUEST_STATUS.MISSING_EVIDENCE]: "Source data unavailable",
  [REQUEST_STATUS.FAILED]: "Failed",
});
