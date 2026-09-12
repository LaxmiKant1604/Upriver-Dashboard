// WORK C/D final correction (blocker 1) -- the LHv3 SEMANTIC payload-identity check. A promoted live row can pass the
// structural validatePayload while its PAYLOAD is for a DIFFERENT account or a DIFFERENT day/window than the row's
// (report_key, account_id, params_hash) identity claims (Codex repro: exact D-1 row identity + params_hash, but
// payload.accountId="OTHER" and payload.asOf/window.to=D-2). This proves the payload's OWN account/date/window agree
// with the requested account + the live params.to, and that the default view is the canonical 30D window the reconciler
// promotes. Wired as the OPTIONAL contract.semanticIdentity hook on ONLY the listing-health-v3 live-snapshot contract
// (every other report has no hook -> byte-identical), and run by BOTH the shared live-promoted resolver (readback +
// serve) AND the publisher gate. PURE. 7-bit ASCII, LF.

import { addDaysStr } from "../date-windows.js";
import { LISTING_HEALTH_DEFAULT_WINDOW_DAYS } from "./listing-health-advanced.js";

const S = (v) => (v == null ? "" : String(v));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A REAL UTC calendar date (round-trip): rejects 2026-02-30 / 2026-99-99 / 0000-00-00 / bad leap days.
function isRealDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00.000Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Prove the promoted listing-health-v3 payload's OWN identity agrees with the requested account + the live params.to
 * (the exact D-1) + the canonical 30D default window. Returns { ok:true } or { ok:false, reason }.
 *   payload   -- the hydrated, structurally-validated listing-health-v3 payload
 *   accountId -- the requested (authorized) account
 *   to        -- the live params.to (the exact expected D-1)
 */
export function listingHealthV3SemanticIdentity(payload, { accountId, to } = {}) {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "payload-not-object" };
  if (!isRealDate(S(to))) return { ok: false, reason: "expected-to-not-a-date" };
  if (S(payload.accountId) !== S(accountId)) return { ok: false, reason: "payload-account-mismatch" };
  if (S(payload.asOf) !== S(to)) return { ok: false, reason: "payload-asof-mismatch" };
  const w = payload.window;
  if (!w || typeof w !== "object" || Array.isArray(w)) return { ok: false, reason: "payload-window-missing" };
  // Canonical DEFAULT window: kind=30D, days=30, to === params.to (D-1), from === to-(30-1). Both endpoints are real
  // calendar dates and internally consistent (from <= to). A non-default kind/days or a shifted endpoint is rejected
  // (the promoted row is ONLY ever the reconciler's 30D-default derivation).
  if (S(w.kind) !== "30D" || Number(w.days) !== LISTING_HEALTH_DEFAULT_WINDOW_DAYS) return { ok: false, reason: "payload-window-kind" };
  if (!isRealDate(S(w.from)) || !isRealDate(S(w.to))) return { ok: false, reason: "payload-window-dates" };
  if (S(w.to) !== S(to)) return { ok: false, reason: "payload-window-to" };
  if (S(w.from) !== S(addDaysStr(S(to), -(LISTING_HEALTH_DEFAULT_WINDOW_DAYS - 1)))) return { ok: false, reason: "payload-window-from" };
  if (S(w.from) > S(w.to)) return { ok: false, reason: "payload-window-reversed" };
  // Coverage: assessOliCoverage always returns { requestedFrom, requestedTo, coveredFrom, coveredTo, complete, gaps }
  // (listing-health-advanced.js), so a genuine promoted payload always carries it. It must be INTERNALLY CONSISTENT
  // with the window: the requested range equals the window, `complete` is a boolean (with no gaps when complete), and
  // any present covered endpoint is a REAL calendar date inside [from,to]. A malformed/degraded coverage can never
  // pretend to be the account's exact-D-1 coverage.
  const cov = payload.coverage;
  if (!cov || typeof cov !== "object" || Array.isArray(cov)) return { ok: false, reason: "payload-coverage-missing" };
  if (S(cov.requestedFrom) !== S(w.from) || S(cov.requestedTo) !== S(w.to)) return { ok: false, reason: "payload-coverage-window" };
  if (typeof cov.complete !== "boolean") return { ok: false, reason: "payload-coverage-complete" };
  if (cov.complete === true && Array.isArray(cov.gaps) && cov.gaps.length > 0) return { ok: false, reason: "payload-coverage-gaps" };
  for (const k of ["coveredFrom", "coveredTo"]) {
    const v = cov[k];
    if (v != null && S(v) !== "") {
      if (!isRealDate(S(v))) return { ok: false, reason: "payload-coverage-date" };
      if (S(v) < S(w.from) || S(v) > S(w.to)) return { ok: false, reason: "payload-coverage-range" };
    }
  }
  return { ok: true };
}
