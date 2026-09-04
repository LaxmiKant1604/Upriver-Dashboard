/* Pre-React boot guard (classic, same-origin script so it satisfies CSP script-src 'self').
   Loads BEFORE the module bundle and guarantees the user never sees an unexplained blank page:
   the static #boot-fallback surface (in index.html) shows a loading state immediately, and this
   script swaps it for a calm, recoverable screen if the bundle fails to load / evaluate / mount.
   The top-level React Error Boundary calls window.__upriverBootMounted() once React commits a
   frame (the real shell OR its own recovery screen), which removes the surface.
   It NEVER auto-reloads more than once (sessionStorage-guarded), so it can never loop. */
(function () {
  "use strict";
  var RELOAD_KEY = "upriver:boot-reloaded-at";
  var WINDOW_MS = 20000;
  function now() { return Date.now(); }

  function guardedReloadOnce() {
    try {
      var prev = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
      if (prev && now() - prev < WINDOW_MS) return false; // already reloaded recently -> no loop
      sessionStorage.setItem(RELOAD_KEY, String(now()));
      window.location.reload();
      return true;
    } catch (e) { return false; }
  }

  function refId() {
    try { return "UR-" + now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase(); }
    catch (e) { return "UR-BOOT"; }
  }

  function fallback() { return document.getElementById("boot-fallback"); }

  // Called by the top-level Error Boundary after React commits a frame -> remove the boot surface.
  window.__upriverBootMounted = function () {
    window.__UPRIVER_BOOT_MOUNTED = true;
    try { sessionStorage.removeItem(RELOAD_KEY); } catch (e) {}
    var f = fallback();
    if (f && f.parentNode) f.parentNode.removeChild(f);
  };

  function showRecovery(tryReloadFirst) {
    if (window.__UPRIVER_BOOT_MOUNTED) return;         // React already took over
    if (tryReloadFirst && guardedReloadOnce()) return; // stale deploy -> one cache-busted reload, then recovery
    var f = fallback();
    if (!f) return;
    window.__UPRIVER_BOOT_FAILED = true;
    f.innerHTML =
      '<div class="boot-card" role="alert" aria-live="assertive">'
      + '<div class="boot-mark">UR</div>'
      + '<div class="boot-title">We couldn’t load the workspace</div>'
      + '<div class="boot-sub">Something interrupted loading. Retrying usually fixes it.</div>'
      + '<div class="boot-actions">'
      +   '<button type="button" id="boot-retry" class="boot-btn primary">Retry</button>'
      +   '<button type="button" id="boot-signout" class="boot-btn">Sign out</button>'
      + '</div>'
      + '<div class="boot-ref">Reference: ' + refId() + '</div>'
      + '</div>';
    var r = document.getElementById("boot-retry");
    if (r) r.onclick = function () { window.location.reload(); };
    var s = document.getElementById("boot-signout");
    if (s) s.onclick = function () {
      try {
        var ls = window.localStorage, doomed = [], i, k;
        for (i = 0; i < ls.length; i++) { k = ls.key(i); if (k && (k.indexOf("sb-") === 0 || k.indexOf("upriver:") === 0)) doomed.push(k); }
        for (i = 0; i < doomed.length; i++) ls.removeItem(doomed[i]);
      } catch (e) {}
      window.location.reload();
    };
  }

  // Capture phase so this also catches RESOURCE load errors (the module <script> failing to load
  // does not bubble to window). A failed module bundle -> one cache-busted reload, then recovery.
  window.addEventListener("error", function (e) {
    if (window.__UPRIVER_BOOT_MOUNTED) return;
    var t = e && e.target;
    if (t && t.tagName === "SCRIPT" && (t.type === "module" || /main|assets\//.test(String(t.src || "")))) { showRecovery(true); return; }
    if (e && e.error) showRecovery(false); // a real JS error thrown during module evaluation, before mount
  }, true);

  window.addEventListener("unhandledrejection", function () {
    if (!window.__UPRIVER_BOOT_MOUNTED) showRecovery(false);
  });

  // Backstop: if React never signals a mount, the bundle silently failed -> show recovery (user-driven Retry).
  setTimeout(function () { if (!window.__UPRIVER_BOOT_MOUNTED) showRecovery(false); }, 12000);
})();
