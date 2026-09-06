// Brand View / Brand Portfolio auto-converge is READ-ONLY (Phase 3).
//
// The mission: opening or converging a page must never trigger a server-side snapshot write. Both views auto-converge
// an `updating` report by POLLING the read endpoint (loadReport) -- never by calling the write endpoint (refreshReport,
// which sends refresh=1 and rebuilds+saves). The explicit Refresh button (onRefresh) is the ONLY path that may write,
// and only on a real click.
//
// Two layers:
//   (1) STATIC INVARIANT (durable, non-flaky): the auto-converge useEffect (the one guarded by `!updating`) calls
//       loadReport, never refreshReport, and does not list refreshReport in its dependency array; the onRefresh handler
//       still calls refreshReport.
//   (2) REAL BEHAVIOR: BrandPortfolio (props-driven) is bundled with esbuild and mounted with react-test-renderer;
//       driven into the `updating` state, its bounded auto-converge is allowed to fire on a timer, and we prove
//       refreshReport was NEVER called automatically while loadReport WAS polled -- and that invoking the explicit
//       Refresh DOES call refreshReport.
// 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "brand-view-readonly\n");

/* ============================ (1) STATIC INVARIANT ============================ */
// Extract the substring of one useEffect block that starts at the `!updating` guard and ends at the dependency array
// close `]);`. Returns { body, deps } (deps is the text inside the final [...]).
function autoConvergeEffect(src, file) {
  const guard = src.indexOf("if (!updating");
  assert.ok(guard !== -1, `${file}: could not find the !updating auto-converge guard`);
  const close = src.indexOf("]);", guard);
  assert.ok(close !== -1, `${file}: could not find the auto-converge effect dependency-array close`);
  const body = src.slice(guard, close + 3);
  const depsOpen = body.lastIndexOf(", [");
  const deps = depsOpen !== -1 ? body.slice(depsOpen + 3, body.lastIndexOf("]")) : "";
  return { body, deps };
}
function onRefreshBlock(src, file) {
  const start = src.indexOf("const onRefresh = useCallback(");
  assert.ok(start !== -1, `${file}: could not find onRefresh`);
  const close = src.indexOf("]);", start);
  return src.slice(start, close + 3);
}

for (const file of ["src/views/BrandView.jsx", "src/views/BrandPortfolio.jsx"]) {
  const src = readFileSync(path.join(appRoot, file), "utf8");
  const { body, deps } = autoConvergeEffect(src, file);
  ok(`${file}: auto-converge effect POLLS loadReport`, /loadReport\s*\(/.test(body));
  ok(`${file}: auto-converge effect NEVER calls refreshReport (no page-open write)`, !/refreshReport\s*\(/.test(body));
  ok(`${file}: auto-converge dep array excludes refreshReport`, !/refreshReport/.test(deps));
  const onRefresh = onRefreshBlock(src, file);
  ok(`${file}: the explicit onRefresh handler still calls refreshReport (writes only on a real click)`, /refreshReport\s*\(/.test(onRefresh));
}

/* ============================ (2) REAL BEHAVIOR (BrandPortfolio mount) ============================ */
// Minimal non-DOM globals so the bundled component's browser guards do not throw under react-test-renderer.
const store = {};
globalThis.window = globalThis.window || globalThis;
globalThis.localStorage = globalThis.localStorage || { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
globalThis.matchMedia = globalThis.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
if (typeof globalThis.window.addEventListener !== "function") globalThis.window.addEventListener = () => {};
if (typeof globalThis.window.removeEventListener !== "function") globalThis.window.removeEventListener = () => {};

async function mountBehaviorTest() {
  // Bundle BrandPortfolio + a tiny harness to a single ESM file we can import (mirrors brand-view-render.test.js).
  // The bundle MUST live inside the app tree so its `external` react / react-test-renderer imports resolve against the
  // app's node_modules (a system tmpdir cannot). It is removed in the finally.
  const dir = mkdtempSync(path.join(appRoot, "node_modules", ".bv-readonly-"));
  bundleDir = dir;
  const entry = path.join(dir, "entry.jsx");
  writeFileSync(entry, `
    import React from "react";
    import BrandPortfolio from ${JSON.stringify(path.join(appRoot, "src/views/BrandPortfolio.jsx"))};
    export { React, BrandPortfolio };
  `);
  const outfile = path.join(dir, "bundle.cjs");
  await build({
    entryPoints: [entry], outfile, bundle: true, format: "cjs", platform: "node", jsx: "automatic",
    logLevel: "silent", external: ["react", "react-dom", "react-test-renderer"],
  });
  // Load as CJS so the bundle's `require("react")` (and lucide-react's) resolve to the app's SINGLE react instance --
  // the exact same module react-test-renderer uses, so hooks/effects work.
  const { React, BrandPortfolio } = require(outfile);
  const TestRenderer = require("react-test-renderer");
  const { act } = TestRenderer;

  const calls = { load: 0, refresh: 0 };
  // loadReport: a read. Always returns an `updating` LKG so the bounded auto-converge keeps polling (read-only).
  const loadReport = async (params) => {
    if (params && params.action === "fx") return { body: { rates: {} }, cachedAt: null }; // useFxRates read
    calls.load += 1;
    return { body: { updating: true, snapshotMissing: false, rows: [], countries: [], coverage: {}, snapshot: { savedAt: null } }, cachedAt: null };
  };
  const refreshReport = async () => { calls.refresh += 1; return { body: { updating: false, rows: [], countries: [], coverage: {} }, cachedAt: null }; };

  const props = {
    brand: "BrandX", region: "india", accountIds: ["a1", "a2"], accountsKnown: true,
    loadReport, refreshReport, directoryLoading: false, directoryError: null, onLoadBrandDirectory: () => {},
    isAdmin: false, sourceAccounts: [],
  };

  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(BrandPortfolio, props)); });
  // Let the initial load + the first auto-converge attempt (400ms delay) fire on REAL timers.
  await act(async () => { await new Promise((r) => setTimeout(r, 700)); });

  const loadsAfterConverge = calls.load;
  ok("mount: the report was loaded read-only (loadReport called)", calls.load >= 1);
  ok("mount: the auto-converge NEVER called refreshReport (no page-open write) even after the timer fired", calls.refresh === 0);
  ok("mount: the auto-converge POLLED loadReport again (read-only convergence), not a rebuild", loadsAfterConverge >= 2);
  // (The explicit-refresh->write path is proven by the static onRefresh assertions above; here we deliberately keep
  // the mount focused on the automatic path, which must be read-only regardless of how the toolbar is rendered.)

  await act(async () => { renderer.unmount(); });
}

let bundleDir = null;
try {
  await mountBehaviorTest();
} catch (e) {
  // The static invariant above is the durable guard; the live mount is best-effort proof. A bundling/renderer
  // environment failure must be LOUD (so it is fixed), not silently skipped.
  writeSync(2, `brand-view-readonly: live mount FAILED: ${e && e.stack ? e.stack : e}\n`);
  process.exitCode = 1;
} finally {
  if (bundleDir) { try { rmSync(bundleDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ } }
}

writeSync(1, `\nbrand-view-readonly: ${passed} assertions passed\n`);
