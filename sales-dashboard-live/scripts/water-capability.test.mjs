// WaterBackground capability decision — focused unit test (offline, no DOM).
//
// Proves the ONE rule that gates the Dashboard's WebGL water layer:
// reduced-motion, a coarse pointer on a small viewport, or a very low core
// count all fall back to the static CSS wash; a capable desktop runs the layer.
// The component wires real browser probes into this pure function, so keeping
// the branches proven here keeps the safety envelope honest without a browser.
//
// 7-bit ASCII, LF, no top-level await.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { shouldUseStaticFallback } from "../src/lib/water-capability.js";

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  writeSync(1, `  ok ${name}\n`);
}

writeSync(1, "water-capability\n");

// A capable desktop: fine pointer (coarse=false), wide viewport, many cores.
ok("capable desktop runs WebGL", shouldUseStaticFallback({
  reduceMotion: false, coarsePointer: false, innerWidth: 1440, cores: 8,
}) === false);

// Reduced motion always wins, regardless of everything else.
ok("reduced-motion forces static fallback", shouldUseStaticFallback({
  reduceMotion: true, coarsePointer: false, innerWidth: 1920, cores: 16,
}) === true);

// Coarse pointer on a small viewport (phone) -> static.
ok("coarse + small viewport -> static", shouldUseStaticFallback({
  reduceMotion: false, coarsePointer: true, innerWidth: 390, cores: 8,
}) === true);

// Coarse pointer on a WIDE screen (e.g. a large touch display) keeps the layer.
ok("coarse + wide viewport keeps WebGL", shouldUseStaticFallback({
  reduceMotion: false, coarsePointer: true, innerWidth: 1600, cores: 8,
}) === false);

// Very low core count -> static (low-power guard).
ok("<=3 cores -> static", shouldUseStaticFallback({
  reduceMotion: false, coarsePointer: false, innerWidth: 1440, cores: 2,
}) === true);
ok("exactly 3 cores -> static", shouldUseStaticFallback({
  reduceMotion: false, coarsePointer: false, innerWidth: 1440, cores: 3,
}) === true);
ok("4 cores runs WebGL", shouldUseStaticFallback({
  reduceMotion: false, coarsePointer: false, innerWidth: 1440, cores: 4,
}) === false);

// Unknown / missing capabilities must never crash and must not force fallback
// on their own (a real environment always supplies the probes).
ok("empty capabilities do not force fallback", shouldUseStaticFallback({}) === false);
ok("no-arg call is safe", shouldUseStaticFallback() === false);
ok("unknown core count is ignored", shouldUseStaticFallback({
  reduceMotion: false, coarsePointer: false, innerWidth: 1440, cores: undefined,
}) === false);

writeSync(1, `\nwater-capability: ${passed} assertions passed\n`);
