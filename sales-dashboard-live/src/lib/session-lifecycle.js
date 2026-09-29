/* =====================================================================
   session-lifecycle -- pure decisions behind stable stale-while-revalidate
   =====================================================================

   The authenticated shell used to be replaced by a full-page bootstrap screen
   ("Loading your Amazon accounts...") every time the browser tab regained focus
   or Supabase refreshed the access token. The root cause was two over-eager
   invalidations at the App root:

     1. the access-loading effect keyed on the access TOKEN, so a routine
        TOKEN_REFRESHED (new JWT, same user) re-ran it, nulled `access`, and
        unmounted the entire DashboardApp (accounts, WaterBackground, scroll);
     2. a focus/visibility revalidation always built a NEW `access` object, whose
        fresh array references cascaded into the account-directory effect and
        flipped it back into its full-page loading state.

   These helpers are the single source of truth for the corrected decisions so
   they can be unit-tested directly (App.jsx wires to them). They are pure and
   framework-free: no React, no DOM, no network.

   Security is preserved, not traded away: a token refresh keeps the mounted
   dashboard ONLY while the authorization scope is byte-identical. The moment the
   scope fingerprint changes (a grant added/removed, a brand-scope change, a role
   change, a different user), `accessScopeChanged` returns true and the caller
   applies the new access -- which purges now-unauthorized cache and re-resolves
   every scope. Keeping the old screen is never allowed to leak another scope's
   data. */

// A stable CLIENT authorization fingerprint. It changes whenever the user id,
// role, account grants, brand-scope mode, or the selected brand keys change --
// exactly the mutations that must invalidate every cached report and re-resolve
// the account/brand selectors. A pure token refresh (same user, same grants)
// produces an IDENTICAL fingerprint, which is what lets a refresh stay silent.
export function accessFingerprintClient(access) {
  const grants = access && access.accountGrants ? access.accountGrants : {};
  const parts = Object.keys(grants).sort().map((a) => {
    const g = grants[a] || {};
    const keys = Array.isArray(g.brandKeys) ? [...g.brandKeys].sort() : [];
    return `${a}:${g.mode || "ALL_BRANDS"}:${keys.join("|")}`;
  });
  return JSON.stringify({ u: (access && access.userId) || "", r: (access && access.role) || "", g: parts });
}

// Revalidated access is applied to React state ONLY when its scope fingerprint
// changed. An identical fingerprint is a silent no-op -- no setAccess, so no
// re-render and no account/report re-fetch cascade -- which keeps a background
// session/access refresh invisible while valid same-scope content stays on
// screen. `prev === null` (nothing applied yet) always counts as changed so the
// first, cold load always lands.
export function accessScopeChanged(prevFingerprint, nextFingerprint) {
  return prevFingerprint !== nextFingerprint;
}

// The access-loading effect keys on the STABLE user identity, never the access
// token: a Supabase TOKEN_REFRESHED (or a SIGNED_IN emitted on focus recovery)
// mints a new token for the SAME user, and re-running the effect on the token
// would blank the whole app. Keying on this value means a token refresh does not
// re-run it at all; only a genuine identity change (or first load) cold-boots.
export function accessReloadKey(session) {
  return session && session.user ? (session.user.id || null) : null;
}

// Which Supabase auth events must HARD-CLEAR authorized access (a genuine loss of
// identity). Everything else -- TOKEN_REFRESHED, SIGNED_IN (focus recovery),
// USER_UPDATED, INITIAL_SESSION, PASSWORD_RECOVERY -- keeps the mounted
// dashboard; setSession updates the JWT and the user-id-keyed effect decides the
// rest. A different user signing in changes the reload key, which cold-boots on
// its own, so only an explicit sign-out is handled here.
export function authEventClearsAccess(event) {
  return event === "SIGNED_OUT";
}

// A full-page bootstrap loading/error screen may appear ONLY in the cold state:
// no usable authorized accounts have been rendered yet. Once at least one account
// exists, a background directory refresh or a transient refresh error must never
// blank the app -- it stays as a quiet indicator with the shell + content intact.
export function isColdAccountState(accountCount) {
  return !(accountCount > 0);
}

// Project an account directory down to the currently-authorized set. Called
// synchronously the instant the authorized set narrows (a revoked grant) so the
// selector can never show -- or keep selected -- an account the user may no
// longer access, without waiting for the background directory refetch. Admins are
// unrestricted. Returns the SAME array reference when nothing was removed so it
// never triggers a needless re-render.
export function projectAuthorizedAccounts(accounts, allowedAccountIds, isAdmin) {
  if (isAdmin) return accounts;
  const list = Array.isArray(accounts) ? accounts : [];
  const next = list.filter((a) => allowedAccountIds.has(String(a && a.id)));
  return next.length === list.length ? accounts : next;
}

// Read-request coalescer: concurrent identical reads (the same owner+scope cache
// key) share ONE in-flight promise instead of firing duplicate network requests.
// This deduplicates the burst that a page mount + a focus revalidation + the
// interval tick would otherwise produce for the account directory and every
// report. It is read-only by contract -- callers never route a DataDoe refresh
// through it -- so sharing a result can never merge two writes.
export function createInFlightCoalescer() {
  const inFlight = new Map();
  return {
    run(key, fn) {
      const existing = inFlight.get(key);
      if (existing) return existing;
      let promise;
      try {
        promise = Promise.resolve(fn());
      } catch (err) {
        return Promise.reject(err);
      }
      const tracked = promise.finally(() => {
        if (inFlight.get(key) === tracked) inFlight.delete(key);
      });
      inFlight.set(key, tracked);
      return tracked;
    },
    get size() { return inFlight.size; },
  };
}

// ---- Cold access-load recovery (2026-09-29 incident) ----------------------------------------------------------------
// The first /api/access?action=me of a session can fail TRANSIENTLY: the database behind Supabase Auth was overloaded
// and the access check returned 500 / timed out. Before this fix that first failure pinned "Access unavailable" for
// good -- a later successful focus revalidation applied the access but never cleared the error. Rules:
//   - a TRANSIENT failure (network error / no status, 5xx, 408, 429) is retried automatically, at most
//     ACCESS_AUTO_RETRY_LIMIT times with a bounded backoff; a definitive answer (401 unauthenticated, 403 / other 4xx)
//     is NOT retried automatically (fail-closed; the user can still press Retry or sign out). Nothing signs the user out;
//   - the error is cleared ONLY by a successful, AUTHORIZED response (isAuthorizedAccessBody) -- never by a malformed or
//     empty body, which counts as a failure;
//   - once authorized access is applied, NO failure (a background revalidation, or a late response of an earlier
//     request) sets the error: a working dashboard is never blanked.
export const ACCESS_AUTO_RETRY_LIMIT = 4;

/** 'transient' | 'unauthenticated' | 'denied' for a failed access load (error.status set by authFetch; none = network). */
export function accessFailureKind(error) {
  const status = error && Number.isInteger(error.status) ? error.status : 0;
  if (status === 0 || status === 408 || status === 429 || (status >= 500 && status <= 599)) return "transient";
  if (status === 401) return "unauthenticated";
  return "denied";
}

/** The delay before automatic retry number `n` (1-based): 2 s, 4 s, 8 s, 16 s -- never more than 30 s. */
export function accessRetryDelayMs(n) {
  const k = Math.max(1, Math.floor(Number(n) || 1));
  return Math.min(30000, 2000 * 2 ** (k - 1));
}

/** Retry automatically only a TRANSIENT failure, and only while under the bound. */
export function shouldAutoRetryAccess(error, retriesSoFar) {
  return accessFailureKind(error) === "transient" && Number(retriesSoFar) < ACCESS_AUTO_RETRY_LIMIT;
}

/** An access body is AUTHORIZED only with an access object carrying a user id and a role (fail-closed otherwise). */
export function isAuthorizedAccessBody(body) {
  const a = body && typeof body === "object" ? body.access : null;
  return !!(a && typeof a === "object" && !Array.isArray(a) && typeof a.userId === "string" && a.userId !== "" && typeof a.role === "string" && a.role !== "");
}

/**
 * The access loader App.jsx drives (one per user identity). fetchAccess() -> the parsed /api/access?action=me body
 * (rejects with error.status on a non-OK response, or a network error); applyAccess(access) applies an authorized
 * access (App: only when the scope fingerprint changed); showError(message) / showRetry({ attempt, of, inMs } | null)
 * drive the cold error screen; hasAppliedAccess() -> true once authorized access is on screen.
 * -> { load(), retryNow(), dispose() }. load() is the first load AND every focus / visibility revalidation.
 */
export function createAccessLoader({ fetchAccess, applyAccess, showError, showRetry, hasAppliedAccess, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let active = true, timer = null, retries = 0;
  const cancel = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  const load = () => Promise.resolve()
    .then(() => fetchAccess())
    .then((body) => {
      if (!active) return;
      if (!isAuthorizedAccessBody(body)) { const e = new Error("Dashboard access response was incomplete."); e.status = 502; throw e; }
      cancel(); retries = 0;
      // The ONLY place the error screen is cleared: a successful, authorized access response.
      showError(""); showRetry(null);
      applyAccess(body.access);
    })
    .catch((error) => {
      if (!active) return;
      // A working dashboard is never blanked: once authorized access is applied, a failure changes nothing.
      if (hasAppliedAccess()) return;
      showError((error && error.message) || "Unable to load dashboard access.");
      if (timer !== null) return; // an automatic retry is already scheduled
      if (shouldAutoRetryAccess(error, retries)) {
        retries += 1;
        const inMs = accessRetryDelayMs(retries);
        showRetry({ attempt: retries, of: ACCESS_AUTO_RETRY_LIMIT, inMs });
        timer = setTimer(() => { timer = null; if (active) load(); }, inMs);
      } else {
        showRetry(null);
      }
    });
  return {
    load,
    // The Retry button: load now and restart the bounded automatic retries (never signs out).
    retryNow() { if (!active) return Promise.resolve(); cancel(); retries = 0; showRetry(null); return load(); },
    dispose() { active = false; cancel(); },
  };
}
