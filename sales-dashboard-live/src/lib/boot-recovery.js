/* =====================================================================
   boot-recovery -- pure decisions behind the boot / stale-chunk recovery
   =====================================================================

   The app must NEVER present an unexplained blank white document. Three layers
   cooperate to guarantee that:

     1. a static boot surface in index.html paints during HTML parse (before any
        JS) and is removed only after React commits its first frame;
     2. a top-level React Error Boundary turns any render/effect throw into a calm
        recovery screen instead of unmounting the tree to blank;
     3. a bounded stale-chunk recovery reloads ONCE (cache-busted) when a lazy
        import fails because a new deployment replaced the hashed chunk an old tab
        still references -- guarded so it can never loop.

   This module owns the pure decisions for (2) and (3) so they are unit-testable
   in Node with an injected storage. The index.html inline script mirrors the same
   one-shot reload guard for the pre-React layer (it cannot import an ES module),
   and the boot-recovery test asserts that mirror stays in step. Nothing here
   touches report data, tokens, or DataDoe. */

// sessionStorage key recording the last cache-busted reload, so a stale-chunk
// reload happens at most once per short window (never an infinite loop).
export const CHUNK_RELOAD_KEY = "upriver:chunk-reloaded-at";
export const CHUNK_RELOAD_WINDOW_MS = 20000;

// A short, non-sensitive reference id shown on the recovery screen so a user can
// quote it in a report. Carries no token, account, brand or error detail.
export function generateReferenceId(now = Date.now(), rand = Math.random) {
  const stamp = Math.floor(now).toString(36).toUpperCase();
  const salt = rand().toString(36).slice(2, 6).toUpperCase().padEnd(4, "0");
  return `UR-${stamp}-${salt}`;
}

// Is this error a stale / failed DYNAMIC IMPORT (a lazy chunk that 404'd or failed
// to load)? Covers the Vite + Chromium + Firefox + Safari message variants. Such
// an error after a deployment is recoverable by one cache-busted reload; other
// errors are not (they get the recovery screen instead).
export function isStaleChunkError(err) {
  const message = String((err && (err.message || err.reason || err.name)) || err || "");
  return /dynamically imported module|Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module|ChunkLoadError|Loading chunk [\w-]+ failed|'text\/html' is not a valid JavaScript MIME type/i.test(message);
}

// Should we perform the one-shot cache-busted reload for a stale chunk now? True
// at most once per CHUNK_RELOAD_WINDOW_MS, so a persistently-failing chunk shows
// the recovery screen instead of reloading forever. Fail-safe: any storage error
// returns false (no reload) so we never loop when storage is unavailable.
export function shouldReloadForStaleChunk(storage, now = Date.now()) {
  try {
    const prev = Number(storage.getItem(CHUNK_RELOAD_KEY) || 0);
    if (prev && now - prev < CHUNK_RELOAD_WINDOW_MS) return false;
    return true;
  } catch (_e) {
    return false;
  }
}

export function markChunkReloaded(storage, now = Date.now()) {
  try { storage.setItem(CHUNK_RELOAD_KEY, String(Math.floor(now))); } catch (_e) { /* storage may be unavailable */ }
}

// Cleared once the app mounts successfully, so a genuinely-new stale chunk in the
// future is allowed its own one-shot reload.
export function clearChunkReloadMark(storage) {
  try { storage.removeItem(CHUNK_RELOAD_KEY); } catch (_e) { /* storage may be unavailable */ }
}
