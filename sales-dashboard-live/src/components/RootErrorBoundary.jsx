/* =====================================================================
   RootErrorBoundary -- the top-level production safety net
   =====================================================================

   Wraps the entire application. Any render/effect error that would otherwise
   unmount the React tree to a blank white page is caught here and turned into a
   calm, self-contained recovery screen ("We couldn't load the workspace") with a
   Retry, a Sign out, and a short non-sensitive reference id -- never the raw
   error, a token, or any account/brand detail.

   It also owns the "React committed its first frame" signal: componentDidMount
   fires once the boundary has mounted -- whether it mounted the real app subtree
   OR (after catching an initial-render error) its own recovery fallback -- so in
   BOTH cases the static boot surface in index.html is removed and its recovery UI
   becomes visible. If the boundary never mounts (the JS bundle itself failed to
   load or evaluate), the index.html watchdog shows recovery instead.

   The recovery screen is styled with inline styles only, so it renders correctly
   even when the app's stylesheet (which lives inside <App/>) never mounted. */

import React from "react";
import { generateReferenceId, isStaleChunkError, clearChunkReloadMark } from "../lib/boot-recovery.js";

// Remove the pre-React boot surface and clear the one-shot stale-chunk reload
// guard: the app is alive (either the shell or this recovery screen is showing).
function signalBooted() {
  try { if (typeof window !== "undefined" && typeof window.__upriverBootMounted === "function") window.__upriverBootMounted(); } catch (_e) { /* noop */ }
  try { if (typeof window !== "undefined" && window.sessionStorage) clearChunkReloadMark(window.sessionStorage); } catch (_e) { /* noop */ }
}

// Best-effort sign out WITHOUT importing the Supabase client (which may itself be
// the failed module): drop the persisted auth tokens, then reload to the login
// screen. Never throws.
function hardSignOutAndReload() {
  try {
    const ls = window.localStorage;
    const doomed = [];
    for (let i = 0; i < ls.length; i++) {
      const key = ls.key(i);
      // Supabase persists its session under "sb-*"; the app's report caches under "upriver:*".
      if (key && (key.indexOf("sb-") === 0 || key.indexOf("upriver:") === 0)) doomed.push(key);
    }
    doomed.forEach((key) => ls.removeItem(key));
  } catch (_e) { /* storage may be unavailable */ }
  reload();
}

function reload() {
  try { window.location.reload(); } catch (_e) { /* noop */ }
}

const STYLES = {
  root: {
    position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
    padding: "24px", background: "#0d1830", color: "#e8edf7", zIndex: 2147483000,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  },
  card: { width: "100%", maxWidth: "420px", textAlign: "center" },
  mark: {
    width: "44px", height: "44px", margin: "0 auto 18px", borderRadius: "11px",
    display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: "16px",
    letterSpacing: "0.06em", color: "#0d1830", background: "linear-gradient(135deg,#7fb2ff,#38e0c4)",
  },
  title: { fontSize: "18px", fontWeight: 800, margin: "0 0 8px" },
  body: { fontSize: "13.5px", lineHeight: 1.6, color: "#9aa6c2", margin: "0 0 20px" },
  actions: { display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap" },
  primary: {
    appearance: "none", border: "0", borderRadius: "9px", padding: "10px 18px", cursor: "pointer",
    fontSize: "13px", fontWeight: 700, color: "#0d1830", background: "#7fb2ff",
  },
  secondary: {
    appearance: "none", borderRadius: "9px", padding: "10px 18px", cursor: "pointer",
    fontSize: "13px", fontWeight: 700, color: "#e8edf7", background: "transparent", border: "1px solid #2a3552",
  },
  ref: { marginTop: "18px", fontSize: "11px", color: "#6b7699", letterSpacing: "0.04em" },
};

export default class RootErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, referenceId: null };
    this.handleRetry = this.handleRetry.bind(this);
    this.handleSignOut = this.handleSignOut.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error, referenceId: generateReferenceId() };
  }

  componentDidMount() {
    // The boundary committed (with the app subtree OR, after an initial-render
    // error, this fallback): the app is alive, so drop the boot surface.
    signalBooted();
  }

  componentDidCatch(error, info) {
    // Console only, for local/devtools diagnosis. No token/account/brand data is
    // in these messages; nothing is sent anywhere.
    try { console.error("Upriver root boundary caught:", error, info && info.componentStack); } catch (_e) { /* noop */ }
    // Ensure the boot surface is gone even if the error arrived after mount.
    signalBooted();
  }

  handleRetry() {
    reload();
  }

  handleSignOut() {
    hardSignOutAndReload();
  }

  render() {
    if (!this.state.error) return this.props.children;
    const stale = isStaleChunkError(this.state.error);
    return (
      <div style={STYLES.root} role="alert" aria-live="assertive">
        <div style={STYLES.card}>
          <div style={STYLES.mark} aria-hidden="true">UR</div>
          <h1 style={STYLES.title}>We couldn&rsquo;t load the workspace</h1>
          <p style={STYLES.body}>
            {stale
              ? "A new version was just deployed. Reloading will pick it up."
              : "Something interrupted loading your dashboard. Your data is safe — retrying usually fixes it."}
          </p>
          <div style={STYLES.actions}>
            <button type="button" style={STYLES.primary} onClick={this.handleRetry}>Retry</button>
            <button type="button" style={STYLES.secondary} onClick={this.handleSignOut}>Sign out</button>
          </div>
          <div style={STYLES.ref}>Reference: {this.state.referenceId}</div>
        </div>
      </div>
    );
  }
}
