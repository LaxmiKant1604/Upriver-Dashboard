// Scheduler v2 -- PURE freshness model for the previous-day (D-1) "force latest" guarantee (ZERO I/O).
//
// Separates the FRESHNESS-ATTEMPT identity (a durable operation key) from the canonical OLI request_hash so a
// forced fresh fetch can bypass the 20h stale-cache adoption WITHOUT corrupting the request hash. Two modes:
//   - normal        : the automatic run's genuine attempt via the fresh daily cycle (no forced re-fetch of an
//                     already-succeeded window). Operation identity: scheduled-fresh/<bucket>/<requestedAsOf>.
//   - force-latest  : additionally FORCES a fresh DataDoe create for the still-missing D-1 rolling window even
//                     when a same-day cycle already holds a succeeded (stale D-2) export. Operation identity:
//                     manual-force/<bucket>/<requestedAsOf>/<github.run_id>. Idempotent by run_id; a NEW authorized
//                     run_id may re-attempt the still-missing window.
// Only workflow_dispatch may select force-latest; a scheduled event is ALWAYS normal (enforced by the workflow).

import { ROUTING_SCOPES } from "./scheduler-scope.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
// The scopes a freshness op-key may name: the three regions + the legacy revenue buckets (NOT the -fba namespace
// twins -- OLI/freshness cycles are region/legacy only). One source of truth = scheduler-scope.ROUTING_SCOPES.
const BUCKETS = Object.freeze([...ROUTING_SCOPES]);
// Longest-first alternation so 'europe-au'/'non-us'/'us-ca' win over 'us' without relying on regex backtracking;
// hyphens are literal outside a character class, so no escaping is needed.
const SCOPE_ALT = [...ROUTING_SCOPES].sort((a, b) => b.length - a.length).join("|");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/; // github.run_id is a positive integer; accept an id-safe token, no slashes

export const REFRESH_MODES = Object.freeze(["normal", "force-latest"]);
export const SCHEDULED_FRESH_PREFIX = "scheduled-fresh/";
export const MANUAL_FORCE_PREFIX = "manual-force/";

const SCHEDULED_FRESH_RE = new RegExp(`^scheduled-fresh\\/(${SCOPE_ALT})\\/(\\d{4})-(\\d{2})-(\\d{2})$`);
const MANUAL_FORCE_RE = new RegExp(`^manual-force\\/(${SCOPE_ALT})\\/(\\d{4})-(\\d{2})-(\\d{2})\\/([A-Za-z0-9_-]{1,64})$`);

export function assertRefreshMode(mode) {
  const m = S(mode);
  if (!REFRESH_MODES.includes(m)) throw new Error(`refresh_mode must be one of ${REFRESH_MODES.join(" | ")} (got "${m}"); refusing (fail closed).`);
  return m;
}

// The sync_cycles.attempt_kind for a superseding attempt in each mode: a normal (automatic/scheduled) run opens a
// 'scheduled-fresh' superseding attempt; a manual force-latest opens a 'manual-force' one.
export function attemptKindForMode(mode) {
  return assertRefreshMode(mode) === "force-latest" ? "manual-force" : "scheduled-fresh";
}

// A real calendar date check (rejects impossible dates like 2026-02-30).
function isRealDate(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * Build the durable freshness OPERATION KEY for a run. force-latest REQUIRES a nonblank github.run_id (so each
 * authorized manual attempt owns a distinct, idempotent identity); normal never carries a run_id. Fails closed on
 * a bad bucket / date / mode / (missing|malformed) run_id.
 */
export function freshnessOperationKey({ mode, bucket, requestedAsOf, runId = null } = {}) {
  const m = assertRefreshMode(mode);
  const b = S(bucket);
  if (!BUCKETS.includes(b)) throw new Error(`freshnessOperationKey requires bucket in ${BUCKETS.join("|")} (got "${b}"); fail closed.`);
  const at = S(requestedAsOf);
  if (!DATE_RE.test(at) || !isRealDate(Number(at.slice(0, 4)), Number(at.slice(5, 7)), Number(at.slice(8, 10)))) {
    throw new Error(`freshnessOperationKey requires a real YYYY-MM-DD requestedAsOf (got "${at}"); fail closed.`);
  }
  if (m === "normal") {
    if (nb(runId)) throw new Error("freshnessOperationKey: a normal run must NOT carry a run_id (fail closed).");
    return `${SCHEDULED_FRESH_PREFIX}${b}/${at}`;
  }
  const rid = S(runId);
  if (!RUN_ID_RE.test(rid)) throw new Error(`freshnessOperationKey: force-latest requires a valid github.run_id (got "${rid}"); fail closed.`);
  return `${MANUAL_FORCE_PREFIX}${b}/${at}/${rid}`;
}

/**
 * STRICTLY validate + parse a freshness operation key. Only the two exact shapes are accepted; every other shape
 * (blank, unknown prefix, malformed/impossible date, wrong bucket, missing/oversized run_id, trailing junk) fails
 * closed. Returns { mode, bucket, requestedAsOf, runId }.
 */
export function parseFreshnessOperationKey(operationKey) {
  const k = S(operationKey);
  let m = SCHEDULED_FRESH_RE.exec(k);
  if (m) {
    if (!isRealDate(Number(m[2]), Number(m[3]), Number(m[4]))) throw new Error(`freshness operation key "${k}" is not a real calendar date (fail closed).`);
    return { mode: "normal", bucket: m[1], requestedAsOf: `${m[2]}-${m[3]}-${m[4]}`, runId: null };
  }
  m = MANUAL_FORCE_RE.exec(k);
  if (m) {
    if (!isRealDate(Number(m[2]), Number(m[3]), Number(m[4]))) throw new Error(`freshness operation key "${k}" is not a real calendar date (fail closed).`);
    return { mode: "force-latest", bucket: m[1], requestedAsOf: `${m[2]}-${m[3]}-${m[4]}`, runId: m[5] };
  }
  throw new Error(`freshness operation key must be "${SCHEDULED_FRESH_PREFIX}<bucket>/<YYYY-MM-DD>" or "${MANUAL_FORCE_PREFIX}<bucket>/<YYYY-MM-DD>/<run_id>" (got "${k}"); fail closed.`);
}
