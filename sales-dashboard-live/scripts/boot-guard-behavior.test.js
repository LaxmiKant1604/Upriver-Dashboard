// Boot guard BEHAVIOURAL regressions -- executes the REAL public/boot-guard.js in a simulated browser (node:vm),
// not string assertions. Proves the pre-React blank-page defence actually behaves correctly:
//   - a boot failure swaps the loading surface for a recovery screen (Retry / Sign out);
//   - a stale bundle reloads exactly ONCE then shows recovery (never a loop), incl. when storage is unavailable;
//   - benign resource failures (a font/CSS 404) do NOT replace the app with a fatal screen;
//   - once React mounts, the guard is fully disarmed (watchdog cleared, listeners inert) so a healthy running app is
//     never interrupted by a later unrelated error;
//   - Retry reloads; Sign out clears sb-*/upriver:* client state (and only that) then reloads.
//
// 7-bit ASCII, LF, no top-level await.

import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const guardSrc = readFileSync(path.join(root, "public/boot-guard.js"), "utf8");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); }

// Build a minimal but faithful browser environment and run the real boot-guard.js inside it.
function runGuard({ sessionThrows = false, seedReloadKey = null, seedLocal = {} } = {}) {
  const capture = {}; const bubble = {};
  const timers = [];
  const reloads = { count: 0 };
  const removed = { boot: false };
  const sessionData = new Map(); const localData = new Map();
  if (seedReloadKey != null) sessionData.set("upriver:boot-reloaded-at", String(seedReloadKey));
  Object.entries(seedLocal).forEach(([k, v]) => localData.set(k, String(v)));

  const mkStorage = (data, throws) => ({
    getItem(k) { if (throws) throw new Error("blocked"); return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { if (throws) throw new Error("blocked"); data.set(k, String(v)); },
    removeItem(k) { if (throws) throw new Error("blocked"); data.delete(k); },
    key(i) { return [...data.keys()][i] != null ? [...data.keys()][i] : null; },
    get length() { return data.size; },
  });

  const fallbackEl = { id: "boot-fallback", innerHTML: "<loading/>" };
  fallbackEl.parentNode = { removeChild(node) { if (node === fallbackEl) removed.boot = true; } };
  const retryBtn = { id: "boot-retry", onclick: null };
  const signoutBtn = { id: "boot-signout", onclick: null };
  const document = {
    getElementById(id) {
      if (id === "boot-fallback") return removed.boot ? null : fallbackEl;
      if (id === "boot-retry") return retryBtn;
      if (id === "boot-signout") return signoutBtn;
      return null;
    },
  };
  const win = {
    addEventListener(type, fn, useCapture) { const bag = useCapture ? capture : bubble; (bag[type] = bag[type] || []).push(fn); },
    location: { reload() { reloads.count += 1; } },
  };
  win.sessionStorage = mkStorage(sessionData, sessionThrows);
  win.localStorage = mkStorage(localData, false);

  const ctx = {
    window: win, document,
    sessionStorage: win.sessionStorage, localStorage: win.localStorage,
    setTimeout(fn, ms) { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
    clearTimeout(id) { if (timers[id]) timers[id].cleared = true; },
    Date, Math, Number, String, console,
  };
  vm.createContext(ctx);
  vm.runInContext(guardSrc, ctx, { filename: "boot-guard.js" });

  return {
    win, fallbackEl, retryBtn, signoutBtn, reloads, removed, timers, sessionData, localData,
    fireError(ev) { (capture.error || []).forEach((fn) => fn(ev)); },
    fireRejection(ev) { (bubble.unhandledrejection || []).forEach((fn) => fn(ev || {})); },
    fireWatchdog() { timers.filter((t) => !t.cleared).forEach((t) => t.fn()); },
    mount() { win.__upriverBootMounted(); },
    recoveryShown() { return win.__UPRIVER_BOOT_FAILED === true && /We couldn/.test(fallbackEl.innerHTML); },
  };
}

writeSync(1, "boot-guard-behavior\n");

// 1. Successful mount removes the surface, clears the watchdog, clears the reload guard.
(function () {
  const g = runGuard({ seedReloadKey: 123 });
  const watchdog = g.timers[g.timers.length - 1];
  g.mount();
  ok("mount removes the boot surface", g.removed.boot === true);
  ok("mount clears the watchdog timer (no dangling timer on a healthy app)", watchdog.cleared === true);
  ok("mount clears the one-shot reload guard", g.sessionData.has("upriver:boot-reloaded-at") === false);
  ok("mount sets the mounted flag", g.win.__UPRIVER_BOOT_MOUNTED === true);
})();

// 2. Watchdog with no mount -> recovery screen, and it does NOT reload.
(function () {
  const g = runGuard();
  g.fireWatchdog();
  ok("watchdog shows the recovery screen when React never mounts", g.recoveryShown());
  ok("watchdog recovery does not reload the page", g.reloads.count === 0);
})();

// 3. A failed module <script> load -> exactly ONE reload, then recovery on a repeat (never a loop).
(function () {
  const g = runGuard();
  g.fireError({ target: { tagName: "SCRIPT", type: "module", src: "/assets/index-abc.js" } });
  ok("module load failure triggers one cache-busted reload", g.reloads.count === 1);
  ok("the one-shot reload guard is recorded", g.sessionData.get("upriver:boot-reloaded-at") != null);
  g.fireError({ target: { tagName: "SCRIPT", type: "module", src: "/assets/index-abc.js" } });
  ok("a repeat module failure does NOT reload again (no loop)", g.reloads.count === 1);
  ok("the repeat shows the recovery screen instead", g.recoveryShown());
})();

// 4. A benign resource failure (font / CSS) must NOT replace the app with a fatal screen or reload.
(function () {
  const g = runGuard();
  g.fireError({ target: { tagName: "LINK", href: "https://fonts.gstatic.com/x.woff2" } });
  g.fireError({ target: { tagName: "IMG", src: "/logo.png" } });
  ok("a font/image 404 does not show recovery", g.win.__UPRIVER_BOOT_FAILED !== true);
  ok("a font/image 404 does not reload", g.reloads.count === 0);
  ok("a font/image 404 leaves the loading surface intact", g.removed.boot === false && /loading/.test(g.fallbackEl.innerHTML));
})();

// 5. A real JS error thrown during module evaluation (before mount) -> recovery, no reload.
(function () {
  const g = runGuard();
  g.fireError({ error: new Error("boom in module eval"), message: "boom in module eval" });
  ok("a module-eval throw shows recovery", g.recoveryShown());
  ok("a module-eval throw does not reload", g.reloads.count === 0);
})();

// 6. After React mounts, unrelated errors/rejections are inert -> a healthy running app is never interrupted.
(function () {
  const g = runGuard();
  g.mount();
  g.fireError({ error: new Error("late async error") });
  g.fireRejection({ reason: "late rejection" });
  ok("a post-mount error does not show a fatal screen", g.win.__UPRIVER_BOOT_FAILED !== true);
  ok("a post-mount error does not reload", g.reloads.count === 0);
  ok("the app stays mounted (surface stays removed)", g.removed.boot === true);
})();

// 7. An unhandled rejection before mount -> recovery.
(function () {
  const g = runGuard();
  g.fireRejection({ reason: "supabase bootstrap rejected" });
  ok("a pre-mount unhandled rejection shows recovery", g.recoveryShown());
})();

// 8. Storage unavailable (private mode): a module failure must NOT reload (fail-safe) and must still show recovery.
(function () {
  const g = runGuard({ sessionThrows: true });
  g.fireError({ target: { tagName: "SCRIPT", type: "module", src: "/assets/index-abc.js" } });
  ok("storage-unavailable module failure does not reload (no loop)", g.reloads.count === 0);
  ok("storage-unavailable module failure still shows recovery", g.recoveryShown());
})();

// 9. Retry genuinely reloads.
(function () {
  const g = runGuard();
  g.fireWatchdog();
  assert.ok(g.recoveryShown(), "precondition: recovery shown");
  const before = g.reloads.count;
  g.retryBtn.onclick();
  ok("Retry reloads (genuinely retries the boot)", g.reloads.count === before + 1);
})();

// 10. Sign out clears ONLY protected client state (sb-* / upriver:*) then reloads.
(function () {
  const g = runGuard({ seedLocal: { "sb-auth-token": "x", "upriver:datadoe:v2:owner:foo": "y", "theme-pref": "dark" } });
  g.fireWatchdog();
  assert.ok(g.recoveryShown(), "precondition: recovery shown");
  const before = g.reloads.count;
  g.signoutBtn.onclick();
  ok("sign out removes the Supabase session key", g.localData.has("sb-auth-token") === false);
  ok("sign out removes the app cache keys", g.localData.has("upriver:datadoe:v2:owner:foo") === false);
  ok("sign out keeps unrelated local storage", g.localData.get("theme-pref") === "dark");
  ok("sign out reloads to the login screen", g.reloads.count === before + 1);
})();

writeSync(1, `\nboot-guard-behavior: ${passed} assertions passed\n`);
