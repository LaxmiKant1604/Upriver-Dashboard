/* =====================================================================
   shared-report-projection -- identity-gated presentation for useSharedReport
   =====================================================================

   The shared report hook used to hold its payload in a plain `data` state that
   PERSISTED across parameter changes. Because the load is async (it awaits the
   browser cache, then the network), switching the selected account/brand/
   marketplace/date-window left the PREVIOUS account's rows on screen for the
   ~seconds until the new request completed -- a cross-account accuracy and
   isolation defect (the selector already showed the new account).

   This module owns the two pure decisions that close it, so App.jsx wires the
   real localStorage/IndexedDB/fetch I/O to them and they are unit-testable with
   deterministic inputs (no React, no network):

     1. IDENTITY TAGGING + SYNCHRONOUS GATE (projectSharedReport): every held
        payload is tagged with the exact params identity (apiCacheKey -- account,
        brand, marketplace, date-window, report action AND the authorization
        fingerprint) that produced it. A payload is EXPOSED only when its tag
        equals the CURRENT params identity. So any identity change stops showing
        the previous payload SYNCHRONOUSLY, in the same render, before any effect
        or network -- and the view falls to its loading/snapshot state until a
        payload tagged with the new identity lands. Last-known-good is preserved
        ONLY for same-identity revalidation.

     2. LOAD LIFECYCLE (sharedReportReducer): a deterministic model of the load
        sequence keyed by a monotonic request id, so a slow/late response from a
        SUPERSEDED identity can never overwrite the current one and a payload is
        only ever recorded under the exact identity that produced it.

   Security note: this prevents the *previous scope's payload in this browser*
   from being shown under a newly selected scope. It does not (and cannot) erase
   data a previously-authorized user already received. It composes with -- and
   never weakens -- report-cache-scope's authorization-fingerprint isolation
   (the fingerprint is already folded into every identity via apiCacheKey). */

// The initial reducer state: nothing loaded, no in-flight request.
export function sharedReportInitialState() {
  return { reqId: 0, entry: null, loadingKey: null, updatingKey: null, errorEntry: null };
}

// A faithful, pure model of the hook's load lifecycle. Every mutating event carries the monotonic `myId` of the load
// that issued it; the reducer applies it ONLY while it is still the current request (`myId === state.reqId`), so a
// late event from a superseded identity is dropped. `entry` is ALWAYS tagged with the identity `key` that produced it.
//
// Events:
//   { type: "clear" }                                  -> reset (params became null / report inactive teardown)
//   { type: "load-start", myId, key }                  -> a new load becomes authoritative; clears any error. Does NOT
//                                                          touch the held payload (a non-matching one is already hidden
//                                                          by the projection; a matching one stays as last-known-good).
//   { type: "loading", myId, key }                     -> mark a first-paint / manual-refresh load in flight for `key`
//   { type: "cache", myId, key, body, cachedAt }       -> a matching browser cache loaded: show it + revalidate
//   { type: "cache-miss", myId, key }                  -> no browser cache for `key`: first-paint loading
//   { type: "network", myId, key, body, cachedAt }     -> the shared request completed for `key`: authoritative payload
//   { type: "error", myId, key, message }              -> the request failed for `key`
//   { type: "settle", myId }                           -> clear the in-flight loading/updating flags
export function sharedReportReducer(state, event) {
  const s = state || sharedReportInitialState();
  switch (event && event.type) {
    case "clear":
      return sharedReportInitialState();
    case "load-start":
      // A newer load supersedes any older in-flight one (its later events are then ignored by the myId guard). The
      // payload is intentionally preserved: if the new identity matches it, it stays as same-identity last-known-good;
      // if it does not, projectSharedReport hides it regardless.
      return { ...s, reqId: event.myId, errorEntry: null };
    case "loading":
      if (event.myId !== s.reqId) return s;
      return { ...s, loadingKey: event.key };
    case "cache":
      if (event.myId !== s.reqId) return s;
      return { ...s, entry: { key: event.key, body: event.body, cachedAt: event.cachedAt == null ? null : event.cachedAt }, updatingKey: event.key, loadingKey: null };
    case "cache-miss":
      if (event.myId !== s.reqId) return s;
      return { ...s, loadingKey: event.key, updatingKey: null };
    case "network":
      if (event.myId !== s.reqId) return s; // LATE response from a superseded identity -> ignored (no cross-account overwrite)
      return { ...s, entry: { key: event.key, body: event.body, cachedAt: event.cachedAt == null ? null : event.cachedAt }, errorEntry: null, loadingKey: null, updatingKey: null };
    case "error":
      if (event.myId !== s.reqId) return s;
      return { ...s, errorEntry: { key: event.key, message: event.message }, loadingKey: null, updatingKey: null };
    case "settle":
      if (event.myId !== s.reqId) return s;
      return { ...s, loadingKey: null, updatingKey: null };
    default:
      return s;
  }
}

/**
 * The SYNCHRONOUS identity gate. Given the CURRENT params identity, whether the report is active, and the reducer
 * state, return exactly what the hook exposes: { data, loading, updating, error, cachedAt }. A held payload is exposed
 * ONLY when its tag equals `currentKey`; otherwise it is treated as absent (the view shows loading/snapshot state).
 */
export function projectSharedReport({ currentKey = null, active = false, state = null } = {}) {
  const s = state || sharedReportInitialState();
  const entry = s.entry || null;
  // A payload is the CURRENT one only when it is tagged with the current identity. A null currentKey (no params) never
  // matches, so a torn-down / paramless report exposes no data.
  const matches = !!entry && !!currentKey && entry.key === currentKey;
  const error = s.errorEntry && s.errorEntry.key === currentKey ? s.errorEntry.message : null;
  const data = matches ? entry.body : null;
  const cachedAt = matches ? (entry.cachedAt == null ? null : entry.cachedAt) : null;
  // Revalidating this identity's last-known-good in the background: show the payload, flag it updating.
  const updating = !!matches && s.updatingKey === currentKey && !error;
  // First-paint / no-payload-yet loading: active, an identity is expected, no error, and either there is no matching
  // payload (an identity change hid the previous one) OR an explicit same-identity (re)load is in flight (manual
  // refresh, first fetch). This flips true SYNCHRONOUSLY on an identity change and clears when a matching payload lands.
  const loading = !!active && !!currentKey && !error && (!matches || s.loadingKey === currentKey);
  return { data, loading, updating, error, cachedAt };
}
