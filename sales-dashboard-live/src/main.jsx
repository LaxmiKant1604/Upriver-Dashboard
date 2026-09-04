import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import RootErrorBoundary from "./components/RootErrorBoundary.jsx";
import { shouldReloadForStaleChunk, markChunkReloaded } from "./lib/boot-recovery.js";

// Bounded stale-chunk recovery: after a new deployment an already-open tab may
// try to lazy-load a hashed chunk that no longer exists. Vite fires
// `vite:preloadError` for exactly this. Reload ONCE (cache-busted via the
// no-cache index.html), guarded by sessionStorage so it can never loop; if it has
// already reloaded recently, let the error reach the RootErrorBoundary, which
// shows the recovery screen instead of reloading again.
if (typeof window !== "undefined") {
  window.addEventListener("vite:preloadError", (event) => {
    if (shouldReloadForStaleChunk(window.sessionStorage)) {
      markChunkReloaded(window.sessionStorage);
      try { event.preventDefault(); } catch (_e) { /* noop */ }
      window.location.reload();
    }
    // else: fall through -> the failed import rejects -> RootErrorBoundary (or the
    // caller's own catch) surfaces a recoverable state. Never an infinite reload.
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
);
