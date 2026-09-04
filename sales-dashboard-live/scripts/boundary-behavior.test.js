// RootErrorBoundary BEHAVIOURAL regressions -- transpiles and executes the REAL src/components/RootErrorBoundary.jsx
// (via esbuild, already a build dependency) and renders it with react-dom/server, rather than asserting on strings.
// Proves the top-level boundary:
//   - passes a healthy child through unchanged (a healthy app is never replaced);
//   - on a render error, produces the recovery state React uses to catch (getDerivedStateFromError) with a short
//     non-sensitive reference id;
//   - renders the calm recovery screen (Retry / Sign out / Reference) instead of a blank page;
//   - NEVER renders the raw error message or stack (no confidential detail / token leak);
//   - shows the stale-deploy copy for a chunk error.
//
// 7-bit ASCII, LF.

import assert from "node:assert/strict";
import esbuild from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, writeFileSync, rmSync, writeSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const boundaryPath = path.join(root, "src/components/RootErrorBoundary.jsx");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); }

async function main() {
  writeSync(1, "boundary-behavior\n");

  // Transpile the JSX to ESM and place it beside the source so its relative import ("../lib/boot-recovery.js") and
  // "react" resolve exactly as in the app; import it, then remove the temp file.
  const src = readFileSync(boundaryPath, "utf8");
  const { code } = esbuild.transformSync(src, { loader: "jsx", format: "esm" });
  const tmp = path.join(root, "src/components", `.rbtest-${process.pid}-${Date.now()}.mjs`);
  writeFileSync(tmp, code);
  let RootErrorBoundary;
  try {
    ({ default: RootErrorBoundary } = await import(pathToFileURL(tmp).href));
  } finally {
    try { rmSync(tmp); } catch (_e) { /* best effort */ }
  }

  // 1. Healthy pass-through: no error -> renders the children unchanged.
  {
    const inst = new RootErrorBoundary({ children: React.createElement("main", { id: "shell" }, "DASHBOARD") });
    inst.state = { error: null, referenceId: null };
    const html = renderToStaticMarkup(inst.render());
    ok("healthy boundary renders its children (the app), not a recovery screen", /id="shell"/.test(html) && /DASHBOARD/.test(html) && !/We couldn/.test(html));
  }

  // 2. getDerivedStateFromError produces the recovery state React uses to catch a render throw.
  {
    const secret = "SECRET-eyJhbGciOi.token.value";
    const next = RootErrorBoundary.getDerivedStateFromError(new Error(secret));
    ok("getDerivedStateFromError returns the error + a UR- reference id", next && next.error instanceof Error && /^UR-[0-9A-Z]+-[0-9A-Z]{4}$/.test(next.referenceId));
  }

  // 3. Rendered recovery screen: calm copy + controls + reference, and NO raw error text.
  {
    const secret = "SECRET-eyJhbGciOi.token.value.that.must.not.appear";
    const inst = new RootErrorBoundary({ children: React.createElement("div", null, "APP") });
    inst.state = { error: new Error(secret), referenceId: "UR-TEST-0000" };
    const html = renderToStaticMarkup(inst.render());
    ok("recovery screen shows the calm headline", /We couldn/.test(html) && /load the workspace/.test(html));
    ok("recovery screen offers Retry and Sign out", />Retry</.test(html) && />Sign out</.test(html));
    ok("recovery screen shows the reference id", /UR-TEST-0000/.test(html) && /Reference:/.test(html));
    ok("recovery screen does NOT render the app children", !/>APP</.test(html));
    ok("recovery screen NEVER leaks the raw error message / token", !html.includes(secret) && !/eyJhbGciOi/.test(html));
    ok("recovery screen is announced to assistive tech", /role="alert"/.test(html));
  }

  // 4. A stale-deploy chunk error gets the reload-oriented copy.
  {
    const inst = new RootErrorBoundary({ children: React.createElement("div", null, "APP") });
    inst.state = { error: new Error("Failed to fetch dynamically imported module: /assets/x.js"), referenceId: "UR-CHUNK-0001" };
    const html = renderToStaticMarkup(inst.render());
    ok("stale-chunk recovery mentions a new version / reloading", /new version|Reloading/.test(html));
  }

  writeSync(1, `\nboundary-behavior: ${passed} assertions passed\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
