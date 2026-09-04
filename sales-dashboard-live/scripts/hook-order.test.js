// Hook-order (Rules of Hooks) regressions -- reproduces the PRODUCTION crash with REAL React, and guards the real
// source so it cannot come back.
//
// PROVEN production defect (React error #310 "Rendered more hooks than during the previous render", useCallback in
// DashboardApp): a useCallback (handleDashboardModeChange) sat AFTER the accountsLoading / accountsError / no-accounts
// early-return guards. On cold load the first render hits the loading guard (returns early, callback skipped) and the
// second render (accounts arrived) does not (callback runs) -> more hooks than the previous render -> React unmounts
// the tree -> the root boundary shows the recovery screen. Retry reloads into the same cold path, so it never clears.
//
//   A. REAL-REACT reproduction (react-test-renderer): the buggy pattern throws #310 across a loading->loaded update;
//      the corrected pattern (hook before the early return) renders both states with no error.
//   B. SOURCE guard over the real src/App.jsx: no React hook may be called after an early `return` inside App() or
//      DashboardApp(). This FAILS on the broken implementation and passes once the hook is moved above the guards.
//
// 7-bit ASCII, LF.

import assert from "node:assert/strict";
import React from "react";
import TestRenderer from "react-test-renderer";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const { act } = TestRenderer;
const h = React.createElement;
const { useState, useMemo, useCallback, useEffect } = React;

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); }

writeSync(1, "hook-order\n");

/* ===================== A. real-React reproduction ===================== */

// The BROKEN shape: a hook AFTER a conditional early return (exactly DashboardApp's old structure).
function BuggyDashboard({ loading }) {
  useState(0);
  useMemo(() => 1, []);
  if (loading) return h("div", null, "loading"); // early-return guard (accountsLoading && no accounts)
  // eslint-disable-next-line
  const onModeChange = useCallback(() => {}, []); // hook reached ONLY when not loading -> order changes
  return h("div", null, "loaded:" + typeof onModeChange);
}

// The FIXED shape: every hook is called before any early return (stable order every render).
function FixedDashboard({ loading }) {
  useState(0);
  useMemo(() => 1, []);
  const onModeChange = useCallback(() => {}, []); // hook is unconditional now
  if (loading) return h("div", null, "loading");
  return h("div", null, "loaded:" + typeof onModeChange);
}

// Reproduce: loading -> loaded must throw the hook-order error on the buggy component.
{
  const spy = console.error; console.error = () => {}; // React logs the error too; keep test output clean
  let renderer; let threw = null;
  try {
    act(() => { renderer = TestRenderer.create(h(BuggyDashboard, { loading: true })); });
    act(() => { renderer.update(h(BuggyDashboard, { loading: false })); });
  } catch (e) { threw = e; }
  finally { console.error = spy; }
  ok("BROKEN pattern (hook after early return) throws on loading->loaded", threw !== null);
  ok("the thrown error is the React hook-order violation (#310 / more hooks)",
    threw !== null && /more hooks|Rendered more hooks|Rules of Hooks|#310|hook/i.test(String(threw.message)));
}

// The fix: loading -> loaded renders cleanly, no throw, correct content.
{
  let renderer; let threw = null;
  try {
    act(() => { renderer = TestRenderer.create(h(FixedDashboard, { loading: true })); });
    act(() => { renderer.update(h(FixedDashboard, { loading: false })); });
  } catch (e) { threw = e; }
  ok("FIXED pattern (hook before early return) does NOT throw on loading->loaded", threw === null);
  ok("FIXED pattern renders the loaded content", renderer && JSON.stringify(renderer.toJSON()).includes("loaded:function"));
}

// Also prove the reverse transition (loaded -> loading) is safe for the fixed shape (fewer-hooks / #300 class).
{
  let renderer; let threw = null;
  try {
    act(() => { renderer = TestRenderer.create(h(FixedDashboard, { loading: false })); });
    act(() => { renderer.update(h(FixedDashboard, { loading: true })); });
  } catch (e) { threw = e; }
  ok("FIXED pattern survives loaded->loading too (no #300)", threw === null);
}

/* ===================== B. source guard (real App.jsx) ===================== */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = readFileSync(path.join(root, "src/App.jsx"), "utf8");
const lines = app.split("\n");
// A component's OWN top-level statements sit at exactly 2-space indentation; hooks nested inside callbacks/JSX are
// indented further. So an indentation-anchored scan robustly finds the component's own hook calls without being
// fooled by braces inside strings/JSX (which broke a naive brace matcher on this large, JSX-heavy file).
const HOOK_LINE = /^ {2}(?:const [\w[\], ]+ = )?(?:await )?(useState|useEffect|useLayoutEffect|useMemo|useCallback|useRef|useReducer|useContext|useImperativeHandle|useTransition|useDeferredValue|useId|useSyncExternalStore)\(/;
const first = (re) => lines.findIndex((l) => re.test(l));
const firstAfter = (re, after) => { for (let i = after + 1; i < lines.length; i++) if (re.test(lines[i])) return i; return -1; };

// --- DashboardApp: the proven crash site. The mode-change useCallback must be ABOVE the loading/no-accounts guards,
//     and NO top-level hook may appear between the first early-return guard and the component's render return.
const cbLine = first(/^ {2}const handleDashboardModeChange = useCallback/);
const loadingGuard = first(/^ {2}if \(accountsLoading && isColdAccountState/);
const noAcctGuard = first(/^ {2}if \(!isAdmin && access\.accountIds\.length === 0\)/);
const errGuard = first(/^ {2}if \(accountsError && isColdAccountState/);
ok("DashboardApp declares handleDashboardModeChange (the #310 hook)", cbLine >= 0);
ok("the accountsLoading early-return guard exists", loadingGuard >= 0);
ok("handleDashboardModeChange is declared BEFORE the accountsLoading guard", cbLine < loadingGuard);
ok("handleDashboardModeChange is declared BEFORE the no-accounts guard", noAcctGuard >= 0 && cbLine < noAcctGuard);

const firstGuard = Math.min(...[loadingGuard, noAcctGuard, errGuard].filter((i) => i >= 0));
const renderReturn = firstAfter(/^ {2}return \(/, firstGuard);
ok("DashboardApp has a render return after its guards", renderReturn > firstGuard);
const strayInDashboard = lines.slice(firstGuard, renderReturn).filter((l) => HOOK_LINE.test(l));
ok("no top-level hook is called between DashboardApp's first early-return guard and its render return",
  strayInDashboard.length === 0 || (writeSync(1, `     stray: ${strayInDashboard.map((s) => s.trim()).join(" | ")}\n`), false));

// --- App(): its early returns are the trailing auth/access one-liners; assert no top-level hook appears after them.
const appFirstReturn = first(/^ {2}if \(!supabase\) return /);
const appFinalReturn = firstAfter(/^ {2}return <DashboardApp /, appFirstReturn);
ok("App() has its bootstrap guards + final return", appFirstReturn >= 0 && appFinalReturn > appFirstReturn);
const strayInApp = lines.slice(appFirstReturn, appFinalReturn).filter((l) => HOOK_LINE.test(l));
ok("App() calls NO top-level hook after its first early return",
  strayInApp.length === 0 || (writeSync(1, `     stray: ${strayInApp.map((s) => s.trim()).join(" | ")}\n`), false));

writeSync(1, `\nhook-order: ${passed} assertions passed\n`);
