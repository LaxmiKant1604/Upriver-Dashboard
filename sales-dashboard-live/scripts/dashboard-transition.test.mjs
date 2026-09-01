// Dashboard transition-stability regressions (offline, source-invariant).
//
// The Sales Dashboard used to BLINK on every date/account/brand change because
// the KPI + comparison grids were keyed by scope+date, so React unmounted and
// remounted them and the CSS entrance animation replayed (a full-KPI-row flash).
// These assertions fail if that class of defect returns:
//
//   1. .metric-grid / .cmp-grid carry NO key derived from scope/date (stable
//      identity -> in-place, atomic value+label swap, no entrance-animation replay).
//   2. <WaterBackground /> is mounted once for the account Dashboard, NOT keyed by
//      date/account/brand (no WebGL recreation on a data change).
//   3. WaterBackground's create-once effect has an EMPTY dependency array and
//      disposes its GL resources (no renderer/AF leak; mounts once per Dashboard).
//   4. The Sales Trend chart uses only a short (<=200ms) surface-preserving path
//      transition, disabled under reduced motion.
//   5. The motion layer animates NO full-surface opacity/brightness/backdrop on
//      the workspace, and the entrance animation is gated by prefers-reduced-motion.
//
// These are static-source checks because there is no DOM test harness in this
// suite; the empirical frame/luminance proof is the Playwright flash harness.
//
// 7-bit ASCII, LF, no top-level await.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = readFileSync(path.join(root, "src/App.jsx"), "utf8");
const theme = readFileSync(path.join(root, "src/styles/theme.js"), "utf8");
const water = readFileSync(path.join(root, "src/components/WaterBackground.jsx"), "utf8");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); }

// Return the full JSX opening tag "<...>" that contains the first occurrence of `needle`.
function openTagContaining(src, needle) {
  const idx = src.indexOf(needle);
  assert.ok(idx >= 0, `source contains ${needle}`);
  const lt = src.lastIndexOf("<", idx);
  const gt = src.indexOf(">", idx);
  return src.slice(lt, gt + 1);
}

writeSync(1, "dashboard-transition\n");

// 1. The KPI + comparison grids must NOT be keyed (no scope/date remount).
const metricTag = openTagContaining(app, 'className="metric-grid"');
ok("metric-grid has no key= (no remount on filter change)", !/key\s*=/.test(metricTag));
ok("metric-grid key is not derived from date/scope", !/rangeFrom|rangeTo|rangePreset|selectedAccountId|selectedBrand/.test(metricTag));

const cmpTag = openTagContaining(app, 'className="cmp-grid"');
ok("cmp-grid has no key= (no remount on filter change)", !/key\s*=/.test(cmpTag));
ok("cmp-grid key is not derived from date/scope", !/rangeFrom|rangeTo|rangePreset/.test(cmpTag));

// 2. WaterBackground: mounted for the account Dashboard, not keyed by scope/date.
const waterTag = openTagContaining(app, "<WaterBackground");
ok("WaterBackground has no key=", !/key\s*=/.test(waterTag));
ok("WaterBackground is not keyed/gated by date or brand", !/rangeFrom|rangeTo|selectedBrand/.test(waterTag));
// It is guarded by route + account mode only (a stable condition across data changes).
ok("WaterBackground gate references the dashboard route + account mode",
  app.includes('view === "dashboard" && dashboardMode === "account" && <WaterBackground />'));

// 3. WaterBackground effect: create-once (empty deps) + disposes GL resources.
const effectStart = water.indexOf("useEffect(() => {");
ok("WaterBackground has a useEffect", effectStart >= 0);
// The create-once effect ends with the empty-deps signature.
ok("WaterBackground effect has an EMPTY dependency array (mounts once)", /\n\s*\}, \[\]\);/.test(water));
ok("WaterBackground dynamically imports three (own lazy chunk)", /await import\("three"\)/.test(water));
ok("WaterBackground disposes the renderer on cleanup", /renderer\.dispose\(\)/.test(water));
ok("WaterBackground cancels its animation frame on cleanup", /cancelAnimationFrame\(raf\)/.test(water));
ok("WaterBackground still uses the pure capability fallback", /shouldUseStaticFallback/.test(water));

// 4. Chart: short (<=200ms) transition, disabled under reduced motion, surface kept.
const durMatch = app.match(/animationDuration=\{(\d+)\}/);
ok("chart animationDuration is present", !!durMatch);
ok("chart animationDuration <= 200ms (short, surface-preserving)", Number(durMatch[1]) <= 200);
ok("chart animation is disabled under reduced motion", app.includes("isAnimationActive={!prefersReducedMotion}"));

// 5. Motion layer: no full-surface animation; entrance gated by reduced motion.
function ruleBody(src, selector) {
  const idx = src.indexOf(selector + "{");
  if (idx < 0) return "";
  const open = src.indexOf("{", idx);
  const close = src.indexOf("}", open);
  return src.slice(open + 1, close);
}
const wsRule = ruleBody(theme, ".main-area.dash-workspace");
ok("dash-workspace has no animation", !/animation/.test(wsRule));
ok("dash-workspace has no opacity/brightness transition", !/opacity|brightness|backdrop-filter/.test(wsRule));
const containerRule = ruleBody(theme, ".container.dashboard-page");
ok("container.dashboard-page has no animation", !/animation/.test(containerRule));
ok("no brightness() animation anywhere in the theme", !/brightness\(/.test(theme));
ok("entrance animation is gated by prefers-reduced-motion: no-preference",
  /@media \(prefers-reduced-motion: no-preference\)\{[\s\S]*dashRise/.test(theme));
ok("reduced-motion has an explicit static branch", /@media \(prefers-reduced-motion: reduce\)/.test(theme));

writeSync(1, `\ndashboard-transition: ${passed} assertions passed\n`);
