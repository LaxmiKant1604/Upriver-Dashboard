/* =====================================================================
   report-cache-io -- the ASYNC IndexedDB/localStorage read+write core for the
   report cache, with an IMMUTABLE per-request identity (key + generation).
   =====================================================================

   These are the real data-path primitives App.jsx wires to; all I/O (IndexedDB
   open, the object-store transaction, localStorage) is INJECTED so the genuine
   asynchronous writer is unit-testable with controllable transport/storage.

   The contract that closes the remaining permission-cache defects:
     - The caller captures an immutable context (the exact cache KEY and the
       authorization GENERATION) at operation creation and passes it in. NOTHING
       here recomputes an operation's identity from current global state.
     - The generation is re-validated AFTER every asynchronous boundary and
       BEFORE: returning a cached/network result, starting a write, performing a
       localStorage fallback, and delivering a result after a write completes. An
       obsolete result throws AuthScopeChangedError and is NEVER written under, or
       returned as, the current scope.
     - AuthScopeChangedError is NEVER treated as a storage error: it is rethrown
       and never triggers a fallback write.
     - Writes and the purge key off IndexedDB TRANSACTION completion/abort, not
       merely a single request's success.

   io = { openLargeCache, largeStore, storage, purgeBarrier } (all injected). */

import { isObsoleteGeneration, AuthScopeChangedError, isAuthScopeChangedError } from "./report-cache-scope.js";

function readLocal(storage, key) {
  try { const raw = storage && storage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (_e) { return null; }
}
function writeLocal(storage, key, body, cachedAt) {
  try { if (storage) storage.setItem(key, JSON.stringify({ body, cachedAt })); } catch (_e) { /* full/blocked */ }
  return cachedAt;
}

// Read one large-cache entry under an EXACT captured key. Honors the purge barrier: a failed/aborted owner purge makes
// the read BYPASS the cache (return null -> caller does an authorized network read) instead of returning uncertain,
// possibly-previous-scope data. On any IndexedDB error, falls back to the localStorage copy under the SAME key.
export async function scopedLargeRead(key, io) {
  const { ok } = await io.purgeBarrier.ready();
  if (!ok) return null;
  try {
    const db = await io.openLargeCache();
    const cached = await new Promise((resolve, reject) => {
      const request = db.transaction(io.largeStore, "readonly").objectStore(io.largeStore).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    try { db.close(); } catch (_e) { /* noop */ }
    return cached || readLocal(io.storage, key);
  } catch (_e) {
    return readLocal(io.storage, key);
  }
}

// Write one large-cache entry under the CAPTURED key + generation. Re-validates the generation before the IndexedDB
// write AND before any localStorage fallback, so a scope change during the async open/commit can never persist an
// obsolete-scope body -- and, because the key is captured, never under a *different* (current) scope's key. Resolves
// on transaction commit (tx.oncomplete) and treats abort/error as a storage failure (localStorage fallback), but an
// AuthScopeChangedError is rethrown, never swallowed as storage error and never a fallback.
export async function scopedLargeWrite(key, generation, body, io) {
  const cachedAt = Date.now();
  if (isObsoleteGeneration(generation)) throw new AuthScopeChangedError();
  let db;
  try {
    db = await io.openLargeCache();
  } catch (openError) {
    if (isAuthScopeChangedError(openError)) throw openError;
    // storage unavailable -> localStorage fallback, only if still the current scope, under the CAPTURED key.
    if (isObsoleteGeneration(generation)) throw new AuthScopeChangedError();
    return writeLocal(io.storage, key, body, cachedAt);
  }
  // The open may have resolved AFTER the scope changed: re-validate before touching the store.
  if (isObsoleteGeneration(generation)) { try { db.close(); } catch (_e) { /* noop */ } throw new AuthScopeChangedError(); }
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(io.largeStore, "readwrite");
      const request = tx.objectStore(io.largeStore).put({ body, cachedAt }, key);
      request.onerror = () => { try { tx.abort(); } catch (_e) { /* noop */ } };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error("large-cache write transaction aborted"));
      tx.onerror = () => reject(tx.error || new Error("large-cache write transaction failed"));
    });
    try { db.close(); } catch (_e) { /* noop */ }
    return cachedAt;
  } catch (writeError) {
    try { db.close(); } catch (_e) { /* noop */ }
    if (isAuthScopeChangedError(writeError)) throw writeError;
    if (isObsoleteGeneration(generation)) throw new AuthScopeChangedError();
    return writeLocal(io.storage, key, body, cachedAt);
  }
}

// Cache-first large GET with generation validation AFTER the async read (fixes the cache-hit gap) and after the write.
export async function runCachedLargeGet({ key, generation, force, apiGet, io }) {
  if (!force) {
    const cached = await scopedLargeRead(key, io);
    if (cached) {
      if (isObsoleteGeneration(generation)) throw new AuthScopeChangedError(); // never return a prior scope's cache hit
      return { ...cached, fromCache: true };
    }
  }
  const body = await apiGet();
  if (isObsoleteGeneration(generation)) throw new AuthScopeChangedError();
  const cachedAt = await scopedLargeWrite(key, generation, body, io);
  if (isObsoleteGeneration(generation)) throw new AuthScopeChangedError();
  return { body, cachedAt, fromCache: false };
}

// The shared-report load body (the caller runs it inside the coalescer, keyed by the same captured key): fetch ->
// validate -> scoped write -> validate -> deliver. An obsolete result is rejected before it can be written or returned.
export async function runSharedLoad({ key, generation, apiGet, io }) {
  const body = await apiGet();
  if (isObsoleteGeneration(generation)) throw new AuthScopeChangedError();
  const cachedAt = await scopedLargeWrite(key, generation, body, io);
  if (isObsoleteGeneration(generation)) throw new AuthScopeChangedError();
  return { body, cachedAt, fromCache: false };
}
