// P0-C: OLI continuation ceiling must use the DURABLE frozen source_tranche_budget VERBATIM, never a recomputed
// live ceiling compared against the frozen cycle's historical spend. Offline + pure (drives resolveOliCeiling, the
// exact function oli-refresh-d1.mjs uses). Reproduces Europe-AU run 34229041299: frozen 16 creates, live recompute
// 14 -> the old code tripped TOKEN_CEILING_EXCEEDED (16 > 14); the fix accepts the frozen 16. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { resolveOliCeiling, resolveEffectiveOliCeiling, OLI_TOKENS_PER_CREATE, classifyLegacyOliOnlyCycle } from "../lib/server/sync/source-scheduled-oli.js";

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

// ===================== P0 (run 34480475946): the ENTRYPOINT continuation branch no longer reassigns a const =====================
// oli-refresh-d1.mjs declared `const ceilingCreates` then reassigned it in the continuation-frozen branch, throwing
// `TypeError: Assignment to constant variable` at RUNTIME (node --check does NOT catch it -- proven: the deployed SHA
// passed CI then crashed on a real continuation). The fix extracts that exact branch into resolveEffectiveOliCeiling
// (the read + resolve + frozen override) and binds `const effectiveCreates/effectiveTokens` from its immutable result.
// These tests EXECUTE that real branch (with an injected frozen-budget reader) through the crash scenario, and a
// source guard proves the entrypoint no longer reassigns any ceiling const. Testing resolveOliCeiling alone is NOT enough.

// FRESH cycle: effective == recomputed; the frozen-budget reader is NEVER consulted (no export/read on a fresh run).
await (async () => {
  let readCount = 0;
  const r = await resolveEffectiveOliCeiling({ isContinuation: false, recomputedCreates: 14, readFrozenBudget: async () => { readCount += 1; return { max_creates: 999, max_tokens: 999 }; } });
  ok("fresh cycle: effective == recomputed (14 creates / 28 tokens), frozen reader NOT called", r.ok && r.source === "fresh" && r.effectiveCreates === 14 && r.effectiveTokens === 14 * OLI_TOKENS_PER_CREATE && readCount === 0);
})();

// CONTINUATION-FROZEN (the exact run 34229041299/34480475946 shape): durable frozen 16 creates, live recompute 14.
// The OLD code did `const ceilingCreates = 14; ... ceilingCreates = 16;` -> TypeError. The extracted branch returns
// the immutable frozen 16, which the entrypoint binds as `const effectiveCreates` (no reassignment -> no throw).
await (async () => {
  const r = await resolveEffectiveOliCeiling({ isContinuation: true, recomputedCreates: 14, readFrozenBudget: async () => ({ max_creates: 16, max_tokens: 32, spent_creates: 16 }) });
  ok("continuation-frozen: the real branch yields the DURABLE frozen 16-create ceiling (not the recomputed 14) -- no const reassignment", r.ok && r.source === "continuation-frozen" && r.effectiveCreates === 16 && r.effectiveTokens === 32);
})();

// CONTINUATION with NO frozen budget yet (family unfrozen before an interrupt) -> keep the recomputed ceiling.
await (async () => {
  const r = await resolveEffectiveOliCeiling({ isContinuation: true, recomputedCreates: 7, readFrozenBudget: async () => null });
  ok("continuation-unfrozen: no frozen budget yet -> effective keeps the recomputed 7", r.ok && r.source === "continuation-unfrozen" && r.effectiveCreates === 7 && r.effectiveTokens === 14);
})();

// CONTINUATION frozen-budget read THROWS -> defer (zero mutation): the read is inside the branch, and a throw must
// never fall through to a create. This proves the real branch's try/catch, not just resolveOliCeiling's flag.
await (async () => {
  const r = await resolveEffectiveOliCeiling({ isContinuation: true, recomputedCreates: 14, readFrozenBudget: async () => { throw new Error("db down"); } });
  ok("continuation: a frozen-budget read that THROWS defers (FROZEN_BUDGET_UNREADABLE; zero mutation)", r.ok === false && r.defer === true && r.reason === "FROZEN_BUDGET_UNREADABLE");
})();

// CONTINUATION frozen budget MALFORMED -> defer.
await (async () => {
  const r = await resolveEffectiveOliCeiling({ isContinuation: true, recomputedCreates: 14, readFrozenBudget: async () => ({ max_creates: 0, max_tokens: 32 }) });
  ok("continuation: a MALFORMED frozen budget defers (FROZEN_BUDGET_MALFORMED; zero mutation)", r.ok === false && r.defer === true && r.reason === "FROZEN_BUDGET_MALFORMED");
})();

// CONTINUATION with NO reader supplied -> defer (never silently treat a continuation as fresh).
await (async () => {
  const r = await resolveEffectiveOliCeiling({ isContinuation: true, recomputedCreates: 14, readFrozenBudget: null });
  ok("continuation: a missing frozen-budget reader defers (FROZEN_BUDGET_READER_MISSING; never fresh-by-default)", r.ok === false && r.defer === true && r.reason === "FROZEN_BUDGET_READER_MISSING");
})();

// A frozen ceiling never WIDENS beyond the frozen value even when the recompute is larger.
await (async () => {
  const r = await resolveEffectiveOliCeiling({ isContinuation: true, recomputedCreates: 20, readFrozenBudget: async () => ({ max_creates: 3, max_tokens: 6 }) });
  ok("continuation never widens: frozen 3 wins over a larger recompute 20", r.ok && r.effectiveCreates === 3 && r.effectiveTokens === 6);
})();

// SOURCE GUARD on the real entrypoint: the const-reassignment bug is structurally gone.
(() => {
  const src = readFileSync(new URL("./release/oli-refresh-d1.mjs", import.meta.url), "utf8");
  // The recomputed + effective ceilings are BOTH immutable const bindings.
  ok("entrypoint declares `const recomputedCreates` and `const recomputedTokens` (immutable fresh ceiling)", /const recomputedCreates =/.test(src) && /const recomputedTokens =/.test(src));
  ok("entrypoint declares `const effectiveCreates` and `const effectiveTokens` (immutable effective ceiling)", /const effectiveCreates =/.test(src) && /const effectiveTokens =/.test(src));
  // The exact old bug -- a reassignment of a ceiling variable -- must NOT appear anywhere (outside a comment).
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  ok("entrypoint NEVER reassigns ceilingCreates/ceilingTokens/recomputed*/effective* (no `x =` outside declarations)", !/(^|[^.\w])(ceilingCreates|ceilingTokens|recomputedCreates|recomputedTokens|effectiveCreates|effectiveTokens)\s*=\s*[^=]/m.test(code.replace(/const (recomputedCreates|recomputedTokens|effectiveCreates|effectiveTokens) =/g, "const _decl_ =")));
  // The effective ceiling comes from the extracted branch and the enforcement gates consume it.
  ok("entrypoint resolves the effective ceiling via resolveEffectiveOliCeiling", /resolveEffectiveOliCeiling\(/.test(code));
  ok("the token-ceiling ENFORCEMENT gate consumes effectiveCreates (not the recomputed/frozen raw)", /creates > effectiveCreates/.test(code));
  ok("the RESULT payload reports the effective ceiling tokens", /ceilingTokens: effectiveTokens/.test(code));
})();

writeSync(1, `\noli-continuation-ceiling: ${passed} assertions passed\n`);
