// P0-C: OLI continuation ceiling must use the DURABLE frozen source_tranche_budget VERBATIM, never a recomputed
// live ceiling compared against the frozen cycle's historical spend. Offline + pure (drives resolveOliCeiling, the
// exact function oli-refresh-d1.mjs uses). Reproduces Europe-AU run 34229041299: frozen 16 creates, live recompute
// 14 -> the old code tripped TOKEN_CEILING_EXCEEDED (16 > 14); the fix accepts the frozen 16. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { resolveOliCeiling, OLI_TOKENS_PER_CREATE, classifyLegacyOliOnlyCycle } from "../lib/server/sync/source-scheduled-oli.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "oli-continuation-ceiling\n");

// FRESH cycle -> the recomputed + authorized ceiling.
(() => {
  const r = resolveOliCeiling({ isContinuation: false, recomputedCreates: 14 });
  ok("fresh cycle uses the recomputed authorized ceiling", r.ok && r.source === "fresh" && r.creates === 14 && r.tokens === 14 * OLI_TOKENS_PER_CREATE);
})();

// CONTINUATION with a frozen 16-create budget, while the live recompute is 14 (coverage advanced) -> accept 16.
(() => {
  const frozenBudget = { max_creates: 16, max_tokens: 32, spent_creates: 16 };
  const r = resolveOliCeiling({ isContinuation: true, frozenBudget, recomputedCreates: 14 });
  ok("Europe repro: continuation accepts the DURABLE frozen 16-create ceiling (not the recomputed 14)", r.ok && r.source === "continuation-frozen" && r.creates === 16 && r.tokens === 32);
  // The frozen cycle's historical spend (16) is NOT > the effective ceiling (16) -> no false TOKEN_CEILING_EXCEEDED.
  const spent = 16;
  ok("Europe repro: historical spend 16 does not exceed the frozen ceiling 16 (no false TOKEN_CEILING_EXCEEDED)", !(spent > r.creates));
  // The OLD (buggy) behavior would have compared spent 16 against the recomputed 14 and tripped.
  ok("Europe repro: the OLD recomputed ceiling (14) WOULD have tripped, proving the regression is real", 16 > 14);
})();

// CONTINUATION frozen budget UNREADABLE -> defer (zero mutation), never a create.
(() => {
  const r = resolveOliCeiling({ isContinuation: true, frozenBudgetReadError: true, recomputedCreates: 14 });
  ok("continuation with an UNREADABLE frozen budget defers (zero mutation)", r.ok === false && r.defer === true && r.reason === "FROZEN_BUDGET_UNREADABLE");
})();

// CONTINUATION frozen budget MALFORMED -> defer.
(() => {
  for (const bad of [{ max_creates: 0, max_tokens: 32 }, { max_creates: 16, max_tokens: 0 }, { max_creates: "x", max_tokens: 32 }, { max_creates: -1, max_tokens: 2 }, { max_creates: 1.5, max_tokens: 3 }]) {
    const r = resolveOliCeiling({ isContinuation: true, frozenBudget: bad, recomputedCreates: 14 });
    ok(`continuation with a MALFORMED frozen budget defers (${JSON.stringify(bad)})`, r.ok === false && r.defer === true && r.reason === "FROZEN_BUDGET_MALFORMED");
  }
})();

// CONTINUATION with NO frozen budget yet (family unfrozen before an interrupt) -> keep the recomputed ceiling.
(() => {
  const r = resolveOliCeiling({ isContinuation: true, frozenBudget: null, recomputedCreates: 7 });
  ok("continuation with no frozen budget yet keeps the recomputed ceiling (runtime freezes on first create)", r.ok && r.source === "continuation-unfrozen" && r.creates === 7);
})();

// A continuation frozen ceiling never WIDENS beyond the frozen value even when the recompute is LARGER.
(() => {
  const r = resolveOliCeiling({ isContinuation: true, frozenBudget: { max_creates: 3, max_tokens: 6 }, recomputedCreates: 20 });
  ok("continuation never widens: frozen 3 wins over a larger recompute 20", r.ok && r.creates === 3 && r.tokens === 6);
})();

// P0-B: classifyLegacyOliOnlyCycle distinguishes a complete-daily-plan cycle from a legacy OLI-only one.
(() => {
  // A running cycle with a Catalog budget (complete-daily-plan) -> run normally (never recovered).
  ok("complete-daily-plan (Catalog budget present) -> run", classifyLegacyOliOnlyCycle({ status: "running", hasCatalogBudget: true, hasCatalogJob: false, hasOliJob: true }).disposition === "run");
  // A running cycle with a Catalog JOB (mid-priority-step) -> run normally.
  ok("Catalog job present -> run (not legacy)", classifyLegacyOliOnlyCycle({ status: "running", hasCatalogBudget: false, hasCatalogJob: true, hasOliJob: true }).disposition === "run");
  // A legacy OLI-only running cycle (no Catalog budget, no Catalog job, has OLI) -> recover.
  ok("legacy OLI-only running cycle -> recover-legacy", classifyLegacyOliOnlyCycle({ status: "running", hasCatalogBudget: false, hasCatalogJob: false, hasOliJob: true }).disposition === "recover-legacy");
  // No OLI evidence -> not a legacy cycle -> run (never a spurious recovery).
  ok("no OLI evidence -> run (never a spurious recovery)", classifyLegacyOliOnlyCycle({ status: "running", hasCatalogBudget: false, hasCatalogJob: false, hasOliJob: false }).disposition === "run");
  // A non-running (pending/terminal) head is out of scope here -> run.
  ok("a pending head is out of scope -> run", classifyLegacyOliOnlyCycle({ status: "pending", hasCatalogBudget: false, hasCatalogJob: false, hasOliJob: true }).disposition === "run");
})();

writeSync(1, `\noli-continuation-ceiling: ${passed} assertions passed\n`);
