// Boot / blank-page recovery regressions (offline, source-invariant).
//
// The authenticated app could become a COMPLETELY BLANK white page: index.html had an empty <div id="root"> with
// no static boot surface (so a bundle that failed to load/execute painted nothing), and there was NO top-level React
// Error Boundary (so any render/effect throw unmounted the whole tree to blank). This suite proves the permanent
// boot/recovery architecture:
//   A. behavioural unit tests of the pure recovery decisions (src/lib/boot-recovery.js): one-shot cache-busted
//      reload for a stale chunk (never a loop), stale-chunk detection, and a non-sensitive reference id;
//   B. static-source proofs that the three layers are wired: a static boot surface + external CSP-safe boot guard in
//      index.html, a top-level Error Boundary around <App/> that shows a recovery screen (no raw error/token) and
//      signals mount, bounded vite:preloadError recovery in main.jsx, cache headers that let an old tab recover, and
//      WaterBackground's WebGL failure staying caught.
//
// 7-bit ASCII, LF, no top-level await.

import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  generateReferenceId, isStaleChunkError, shouldReloadForStaleChunk, markChunkReloaded,
  clearChunkReloadMark, CHUNK_RELOAD_KEY, CHUNK_RELOAD_WINDOW_MS,
} from "../src/lib/boot-recovery.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const indexHtml = read("index.html");
const bootGuard = read("public/boot-guard.js");
const mainJsx = read("src/main.jsx");
const boundary = read("src/components/RootErrorBoundary.jsx");
const vercel = JSON.parse(read("vercel.json"));
const water = read("src/components/WaterBackground.jsx");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); }

// A minimal in-memory Storage stand-in.
function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), get _size() { return m.size; } };
}

writeSync(1, "boot-recovery\n");

/* ============================ A. behavioural ============================ */

// reference id: shape + non-sensitive
const ref = generateReferenceId(1725450000000, () => 0.123456);
ok("reference id has the UR- prefix and is short", /^UR-[0-9A-Z]+-[0-9A-Z]{4}$/.test(ref));
ok("reference id carries no obvious PII/token", !/@|token|sb-|eyJ/.test(ref));

// stale-chunk detection
[
  "Failed to fetch dynamically imported module: https://x/assets/three.module-abc.js",
  "error loading dynamically imported module",
  "Importing a module script failed",
  "ChunkLoadError: Loading chunk 42 failed",
].forEach((m) => ok(`isStaleChunkError true for: ${m.slice(0, 32)}...`, isStaleChunkError(new Error(m))));
ok("isStaleChunkError false for a generic render error", !isStaleChunkError(new Error("Cannot read properties of undefined (reading 'map')")));
ok("isStaleChunkError tolerates a raw string / reason", isStaleChunkError("Failed to fetch dynamically imported module") && isStaleChunkError({ reason: "ChunkLoadError" }));

// one-shot reload guard (no infinite loop)
const store = fakeStorage();
const t0 = 1725450000000;
ok("first stale chunk -> reload allowed", shouldReloadForStaleChunk(store, t0) === true);
markChunkReloaded(store, t0);
ok("mark recorded under the documented key", store.getItem(CHUNK_RELOAD_KEY) === String(t0));
ok("immediately after a reload -> NOT allowed again (loop guard)", shouldReloadForStaleChunk(store, t0 + 500) === false);
ok("still guarded near the end of the window", shouldReloadForStaleChunk(store, t0 + CHUNK_RELOAD_WINDOW_MS - 1) === false);
ok("after the window elapses -> allowed again (a genuinely new stale chunk)", shouldReloadForStaleChunk(store, t0 + CHUNK_RELOAD_WINDOW_MS + 1) === true);
clearChunkReloadMark(store);
ok("clearing the mark re-allows a reload (called on successful mount)", shouldReloadForStaleChunk(store, t0 + 1000) === true && store._size === 0);
// fail-safe: a throwing storage never triggers a reload
const throwStore = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() {} };
ok("storage failure is fail-safe (no reload, no throw)", shouldReloadForStaleChunk(throwStore, t0) === false);

// The end-to-end "recover once, then stop" sequence a stale deploy produces.
(function () {
  const s = fakeStorage();
  let reloads = 0;
  const onPreloadError = (nowTs) => { if (shouldReloadForStaleChunk(s, nowTs)) { markChunkReloaded(s, nowTs); reloads += 1; } };
  onPreloadError(t0);       // stale chunk #1 -> reload
  onPreloadError(t0 + 100); // fires again immediately -> NO second reload (boundary would show recovery)
  onPreloadError(t0 + 200);
  ok("a repeated stale-chunk error reloads exactly once (never an infinite loop)", reloads === 1);
})();

/* ============================ B. wiring proofs ============================ */

// index.html: static boot surface + external guard BEFORE the module bundle.
ok("index.html has a static boot surface (#boot-fallback)", /id="boot-fallback"/.test(indexHtml));
ok("boot surface shows a loading state before JS", /Loading your workspace/.test(indexHtml));
ok("index.html loads the external boot guard (CSP-safe, not inline)", /<script src="\/boot-guard\.js"><\/script>/.test(indexHtml));
ok("the boot guard is placed BEFORE the app module (handlers registered first)",
  indexHtml.indexOf('/boot-guard.js') < indexHtml.indexOf('/src/main.jsx'));
ok("index.html has NO inline <script> (keeps script-src 'self' intact)", !/<script>[\s\S]*?<\/script>/.test(indexHtml));

// boot-guard.js: mount signal, capture-phase error, unhandledrejection, watchdog, guarded reload, recovery UI.
ok("boot guard defines the mount signal", /window\.__upriverBootMounted\s*=/.test(bootGuard));
ok("boot guard uses a CAPTURE-phase error listener (catches module load failure)", /addEventListener\("error",[\s\S]*?,\s*true\)/.test(bootGuard));
ok("boot guard handles unhandledrejection before mount", /addEventListener\("unhandledrejection"/.test(bootGuard));
ok("boot guard has a no-mount watchdog", /setTimeout\(/.test(bootGuard) && /__UPRIVER_BOOT_MOUNTED/.test(bootGuard));
ok("boot guard reload is one-shot (sessionStorage guarded)", /sessionStorage/.test(bootGuard) && /boot-reloaded-at/.test(bootGuard));
ok("boot guard shows a recovery screen with Retry + Sign out + reference", /We couldn/.test(bootGuard) && /boot-retry/.test(bootGuard) && /boot-signout/.test(bootGuard) && /Reference:/.test(bootGuard));
ok("boot guard sign-out clears sb-/upriver keys then reloads", /indexOf\("sb-"\)/.test(bootGuard) && /indexOf\("upriver:"\)/.test(bootGuard));

// main.jsx: Error Boundary + bounded preload recovery.
ok("main.jsx wraps <App/> in the RootErrorBoundary", /<RootErrorBoundary>[\s\S]*<App \/>[\s\S]*<\/RootErrorBoundary>/.test(mainJsx));
ok("main.jsx recovers stale lazy chunks via vite:preloadError, bounded", /addEventListener\("vite:preloadError"/.test(mainJsx) && /shouldReloadForStaleChunk/.test(mainJsx) && /markChunkReloaded/.test(mainJsx));

// RootErrorBoundary: catches, recovers, signals mount, leaks no error detail.
ok("boundary implements getDerivedStateFromError + componentDidCatch", /getDerivedStateFromError/.test(boundary) && /componentDidCatch/.test(boundary));
ok("boundary signals boot mount (removes the boot surface) on didMount", /componentDidMount/.test(boundary) && /__upriverBootMounted/.test(boundary));
ok("boundary recovery screen has the calm copy + Retry + Sign out + reference", /We couldn/.test(boundary) && />Retry</.test(boundary) && />Sign out</.test(boundary) && /Reference:/.test(boundary));
ok("boundary NEVER renders the raw error message / stack (no confidential detail)",
  !/\{this\.state\.error\.message\}|\{this\.state\.error\}|error\.stack|componentStack\}/.test(boundary));
ok("boundary sign-out is dependency-free (clears sb-/upriver keys, does not import supabase)",
  /indexOf\("sb-"\)/.test(boundary) && !/from "\.\.\/lib\/supabase/.test(boundary));

// vercel.json: HTML revalidates, hashed assets immutable, CSP unchanged (still script-src 'self', no unsafe-inline).
function headerFor(source, key) {
  const entry = (vercel.headers || []).find((h) => h.source === source);
  const hdr = entry && (entry.headers || []).find((x) => x.key === key);
  return hdr ? hdr.value : null;
}
ok("index.html ('/') must-revalidate (old tab recovers after deploy)", /max-age=0/.test(headerFor("/", "Cache-Control") || "") && /must-revalidate/.test(headerFor("/", "Cache-Control") || ""));
ok("hashed /assets are immutable (same-deployment integrity)", /immutable/.test(headerFor("/assets/(.*)", "Cache-Control") || ""));
ok("boot-guard.js revalidates", /max-age=0/.test(headerFor("/boot-guard.js", "Cache-Control") || ""));
const csp = headerFor("/(.*)", "Content-Security-Policy") || "";
ok("CSP still restricts scripts to 'self' (no 'unsafe-inline' was added for boot)", /script-src 'self'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp));
ok("no new Vercel serverless function was added (12-function cap preserved)",
  Object.keys(vercel.functions || {}).length === 1 && "api/datadoe.js" in (vercel.functions || {}));

// WaterBackground: a WebGL / three failure must never crash React.
ok("WaterBackground dynamically imports three inside try/catch (fails to CSS)", /try \{\s*THREE = await import\("three"\);/.test(water) && /return; \/\/ import failed/.test(water));
ok("WaterBackground probes WebGL and bails to the static fallback", /webglAvailable\(\)/.test(water) && /shouldUseStaticFallback/.test(water));

writeSync(1, `\nboot-recovery: ${passed} assertions passed\n`);
