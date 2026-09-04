/* =====================================================================
   report-cache-scope -- authorization-scope isolation for the browser
   report cache (localStorage + IndexedDB) and the in-flight read coalescer
   =====================================================================

   The report cache and the module-global read coalescer previously identified a
   request only by user + report params, NOT by the authorization FINGERPRINT.
   After permissions narrowed, a freshly-mounted subtree could (a) join an
   older-scope in-flight coalesced request and receive revoked-brand data, and
   (b) let that late response repopulate the just-cleared cache. This module owns
   the pure decisions that close both, so App.jsx wires the actual localStorage /
   IndexedDB / fetch I/O to them and they are unit-testable with injected I/O:

     1. every cache key AND every coalescer key carries the authorization
        fingerprint, so a different scope can neither read an entry nor join an
        in-flight read belonging to another scope, and legacy (pre-fingerprint)
        entries are never matched -> never reused;
     2. an authorization GENERATION advances whenever the fingerprint changes; a
        read captures the generation at creation and any obsolete result is
        rejected BEFORE it is returned to a consumer or written to a cache;
     3. the IndexedDB owner-purge is guarded by a barrier that resolves to a
        status: a failed / aborted purge marks the scope's cache UNTRUSTWORTHY so
        the reader bypasses it and does an authorized network read, and it never
        rejects (so it can never deadlock a read).

   Security note: this only prevents a *different scope in this browser* from
   reusing another scope's cached/in-flight data. It does not (and cannot) erase
   data a previously-authorized user already received. */

let cacheFingerprint = ""; // the canonical authorization fingerprint (accessFingerprintClient)
let authGeneration = 0;    // advances on every fingerprint change (a new authorization epoch)

// Set the current authorization fingerprint. Returns the (possibly advanced) generation. Idempotent: calling it again
// with the same fingerprint (e.g. a silent token refresh, or a StrictMode double-render) does NOT advance -- so
// same-scope reads are never treated as obsolete and valid same-scope cache stays reusable.
export function configureReportCacheScope(fingerprint) {
  const next = fingerprint == null ? "" : String(fingerprint);
  if (next !== cacheFingerprint) {
    cacheFingerprint = next;
    authGeneration += 1;
  }
  return authGeneration;
}

export function cacheFingerprintId() { return cacheFingerprint; }
export function currentAuthGeneration() { return authGeneration; }
export function isObsoleteGeneration(generation) { return generation !== authGeneration; }

// Test-only: reset the module scope between test cases.
export function __resetReportCacheScopeForTest() { cacheFingerprint = ""; authGeneration = 0; }

// Thrown when a report read's authorization scope changed while it was in flight. The caller discards it (never writes
// the cache, never returns it as current-scope data). A remount under the new scope issues its own fresh read.
export class AuthScopeChangedError extends Error {
  constructor(message = "Authorization scope changed during an in-flight report read.") {
    super(message);
    this.name = "AuthScopeChangedError";
  }
}
export function isAuthScopeChangedError(error) {
  return !!error && (error instanceof AuthScopeChangedError || error.name === "AuthScopeChangedError");
}

// A purge barrier that NEVER rejects (so a read can never deadlock). `ready()` resolves to { ok }: ok=false means the
// last armed purge failed/aborted (or storage was unavailable) and the reader MUST NOT trust the cache for the current
// scope -- it should bypass and do an authorized network read. Default (nothing armed) is ok=true (cache trusted).
export function createPurgeBarrier() {
  let readyPromise = Promise.resolve({ ok: true });
  return {
    arm(purgePromise) {
      readyPromise = Promise.resolve(purgePromise).then(() => ({ ok: true }), () => ({ ok: false }));
    },
    ready() {
      return readyPromise.then((value) => (value && value.ok ? { ok: true } : { ok: false }), () => ({ ok: false }));
    },
  };
}
