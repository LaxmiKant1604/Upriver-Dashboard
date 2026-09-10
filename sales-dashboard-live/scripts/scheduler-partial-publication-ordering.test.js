// Release-safety regression: the scheduler-v2 publication STEP ORDER + the actual `if:` OUTCOME CONDITIONS (Codex
// corrections 1 & 2). This does NOT grep source strings -- it PARSES each step's `if:` expression and EVALUATES it
// with a small GitHub-Actions expression evaluator against simulated step outcomes, asserting exactly which steps run
// / which notice fires in each scenario:
//   * the partial-cycle capability preflight runs BEFORE controls, and a FAILED/UNREADABLE preflight opens NO controls
//     and publishes nothing (migration-absent, capability-unreadable);
//   * a readiness failure opens no controls and publishes nothing;
//   * a Catalog/publication failure => the Campaign notice reports sales publication FAILED (never "published");
//   * a SUCCESSFUL complete/partial publication with a Campaign failure => the notice reports sales PUBLISHED.
// Offline, no network. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "scheduler-partial-publication-ordering\n");

const HERE = dirname(fileURLToPath(import.meta.url));
const yml = readFileSync(resolve(HERE, "..", "..", ".github", "workflows", "scheduler-v2.yml"), "utf8");

/* ---------------- parse the `run` job's steps: { name, id, if, index } ---------------- */
const steps = [];
{
  const blocks = yml.split(/\n\s+- name:/); // block[0] is the preamble
  for (let i = 1; i < blocks.length; i += 1) {
    const body = blocks[i];
    const name = (body.split("\n")[0] || "").trim();
    const idM = body.match(/\n\s+id:\s*(\S+)/);
    // `if:` may span (it does not here -- each is a single line); capture to end of line.
    const ifM = body.match(/\n\s+if:\s*([^\n]+)/);
    steps.push({ index: i, name, id: idM ? idM[1] : null, cond: ifM ? ifM[1].trim() : null });
  }
}
const byId = (id) => steps.find((s) => s.id === id);
const idxOf = (id) => { const s = byId(id); return s ? s.index : -1; };
const noticeSalesPublished = steps.find((s) => /sales PUBLISHED independently/.test(s.name));
const noticeNoPublication = steps.find((s) => /incomplete\/unverified sales publication/.test(s.name));

/* ---------------- ORDER ---------------- */
ok("partial_preflight runs BEFORE full_controls (capability checked before any control write)", idxOf("partial_preflight") > 0 && idxOf("partial_preflight") < idxOf("full_controls"));
ok("full_controls runs BEFORE both publish steps", idxOf("full_controls") < idxOf("complete_publish") && idxOf("full_controls") < idxOf("partial_publish"));
ok("both publish steps run BEFORE the Campaign notices", idxOf("complete_publish") < noticeSalesPublished.index && idxOf("partial_publish") < noticeSalesPublished.index && idxOf("complete_publish") < noticeNoPublication.index);
ok("both explicit publish IDs exist", !!byId("complete_publish") && !!byId("partial_publish") && !!byId("partial_preflight"));

/* ---------------- notice WORDING: the failed/unverified notice makes NO zero-publication claim ---------------- */
ok("the failed/unverified Campaign notice uses the cautious wording (did not complete or could not be verified; some snapshots may already have been published)",
  /did NOT complete or could not be verified; some snapshots may already have been published/i.test(yml));
ok("the failed/unverified Campaign notice NEVER claims zero publication (no 'NO dashboards were published' / 'no dashboards published' anywhere in the workflow)",
  !/NO dashboards were published/i.test(yml) && !/no dashboards published/i.test(yml));

/* ---------------- a small GitHub-Actions `if:` expression evaluator ---------------- */
// Supports: always(), &&, ||, !, ==, !=, parentheses, string literals '...', and dotted lookups (steps.*.outcome /
// steps.*.outputs.*, etc.). A lookup missing from the context resolves to "" (as GHA does for an unset output; a
// SKIPPED step's outcome we pass explicitly). Truthiness: booleans as-is; a string is truthy iff non-empty.
function evalIf(expr, ctx) {
  const src = expr.replace(/always\(\)/g, "@ALWAYS@");
  const toks = src.match(/@ALWAYS@|\(|\)|&&|\|\||==|!=|!|'[^']*'|[A-Za-z0-9_.\-]+/g) || [];
  let p = 0;
  const peek = () => toks[p];
  const truthy = (v) => (typeof v === "boolean" ? v : String(v) !== "");
  function parseOr() { let v = parseAnd(); while (peek() === "||") { p += 1; const r = parseAnd(); v = truthy(v) || truthy(r); } return v; }
  function parseAnd() { let v = parseNot(); while (peek() === "&&") { p += 1; const r = parseNot(); v = truthy(v) && truthy(r); } return v; }
  function parseNot() { if (peek() === "!") { p += 1; return !truthy(parseNot()); } return parseCmp(); }
  function parseCmp() { let v = parsePrimary(); if (peek() === "==" || peek() === "!=") { const op = toks[p]; p += 1; const r = parsePrimary(); const a = String(v), b = String(r); return op === "==" ? a === b : a !== b; } return v; }
  function parsePrimary() {
    const t = peek();
    if (t === "(") { p += 1; const v = parseOr(); if (peek() !== ")") throw new Error("expected )"); p += 1; return v; }
    if (t === "@ALWAYS@") { p += 1; return true; }
    if (t && t[0] === "'") { p += 1; return t.slice(1, -1); }
    p += 1; return Object.prototype.hasOwnProperty.call(ctx, t) ? ctx[t] : ""; // dotted lookup
  }
  const out = parseOr();
  if (p !== toks.length) throw new Error("trailing tokens in: " + expr);
  return truthy(out);
}
// self-check the evaluator on known shapes
ok("evaluator: always() && A=='x' -> true when A=='x'", evalIf("always() && a.b == 'x'", { "a.b": "x" }) === true);
ok("evaluator: !(A=='s' || B=='s') is false when B=='s'", evalIf("!(a=='s' || b=='s')", { b: "s" }) === false);
ok("evaluator: skipped-step outcome != 'success' is true", evalIf("s.o == 'success'", { "s.o": "skipped" }) === false);

/* ---------------- scenario contexts ---------------- */
const base = {
  "steps.cfg.outputs.scope": "full", "steps.guard.outputs.run_required": "true",
  "steps.tokengate.outcome": "success", "steps.tokengate.outputs.proceed": "true",
  "steps.oli.outcome": "success", "steps.oli.outputs.publishable": "true",
  "steps.readiness.outputs.proceed": "true", "steps.campaign.outcome": "success",
  // default: nothing ran yet (skipped)
  "steps.partial_preflight.outcome": "skipped", "steps.full_controls.outcome": "skipped",
  "steps.complete_publish.outcome": "skipped", "steps.partial_publish.outcome": "skipped",
};
const S = (over) => ({ ...base, ...over });
const CTL = byId("full_controls").cond, CP = byId("complete_publish").cond, PP = byId("partial_publish").cond, PF = byId("partial_preflight").cond;
const NA = noticeSalesPublished.cond, NB = noticeNoPublication.cond;

// S1: PARTIAL, migration ABSENT -> preflight FAILS -> NO controls, NO publish.
{
  const c = S({ "steps.oli.outputs.full_complete": "false", "steps.partial_preflight.outcome": "failure" });
  ok("S1 migration-absent: partial_preflight is REACHED (gate true) so it can fail-close before controls", evalIf(PF, c) === true);
  ok("S1 migration-absent: full_controls does NOT open (capability preflight failed)", evalIf(CTL, c) === false);
  ok("S1 migration-absent: partial_publish does NOT run", evalIf(PP, c) === false);
}
// S2: PARTIAL, capability UNREADABLE -> same as absent (preflight outcome=failure).
{
  const c = S({ "steps.oli.outputs.full_complete": "false", "steps.partial_preflight.outcome": "failure" });
  ok("S2 capability-unreadable: no controls, no publish (identical fail-closed path)", evalIf(CTL, c) === false && evalIf(PP, c) === false);
}
// S3: readiness FAILURE (proceed != true) -> nothing opens/publishes; the preflight itself is gated off.
{
  const c = S({ "steps.oli.outputs.full_complete": "false", "steps.readiness.outputs.proceed": "false" });
  ok("S3 readiness-failure: partial_preflight gate is false (readiness not proven)", evalIf(PF, c) === false);
  ok("S3 readiness-failure: full_controls + both publishes are all false", evalIf(CTL, c) === false && evalIf(CP, c) === false && evalIf(PP, c) === false);
}
// S4: COMPLETE publish SUCCESS + Campaign FAIL -> notice A (sales published), NOT notice B.
{
  const c = S({ "steps.oli.outputs.full_complete": "true", "steps.complete_publish.outcome": "success", "steps.campaign.outcome": "failure" });
  ok("S4 complete-success + campaign-fail: full_controls opens + complete_publish runs (independent of Campaign)", evalIf(CTL, c) === true && evalIf(CP, c) === true);
  ok("S4 complete-success + campaign-fail: notice A (sales PUBLISHED) fires", evalIf(NA, c) === true);
  ok("S4 complete-success + campaign-fail: notice B (no publication) does NOT fire", evalIf(NB, c) === false);
}
// S5: COMPLETE publish FAIL (Catalog/publication/readback failure) + Campaign FAIL -> notice B, NOT notice A.
{
  const c = S({ "steps.oli.outputs.full_complete": "true", "steps.complete_publish.outcome": "failure", "steps.campaign.outcome": "failure" });
  ok("S5 complete-FAIL + campaign-fail: notice A (sales published) does NOT fire (no false 'published' claim)", evalIf(NA, c) === false);
  ok("S5 complete-FAIL + campaign-fail: notice B (sales publication failed/skipped) fires", evalIf(NB, c) === true);
}
// S6: PARTIAL publish SUCCESS + Campaign FAIL -> notice A, NOT notice B; controls opened (preflight ok).
{
  const c = S({ "steps.oli.outputs.full_complete": "false", "steps.partial_preflight.outcome": "success", "steps.partial_publish.outcome": "success", "steps.campaign.outcome": "failure" });
  ok("S6 partial-success + campaign-fail: full_controls opens (preflight succeeded) + partial_publish runs", evalIf(CTL, c) === true && evalIf(PP, c) === true);
  ok("S6 partial-success + campaign-fail: notice A (sales PUBLISHED) fires", evalIf(NA, c) === true);
  ok("S6 partial-success + campaign-fail: notice B does NOT fire", evalIf(NB, c) === false);
}
// S7: PARTIAL publish FAIL + Campaign FAIL -> notice B, NOT notice A.
{
  const c = S({ "steps.oli.outputs.full_complete": "false", "steps.partial_preflight.outcome": "success", "steps.partial_publish.outcome": "failure", "steps.campaign.outcome": "failure" });
  ok("S7 partial-FAIL + campaign-fail: notice A does NOT fire", evalIf(NA, c) === false);
  ok("S7 partial-FAIL + campaign-fail: notice B (sales publication failed/skipped) fires", evalIf(NB, c) === true);
}
// S8: happy COMPLETE publication + Campaign SUCCESS -> NEITHER campaign notice fires.
{
  const c = S({ "steps.oli.outputs.full_complete": "true", "steps.complete_publish.outcome": "success", "steps.campaign.outcome": "success" });
  ok("S8 complete-success + campaign-success: neither Campaign notice fires", evalIf(NA, c) === false && evalIf(NB, c) === false);
}

/* ---------------- LINEAGE PREFLIGHT wiring (Codex: partial_publish uses the REFINED eligible_ids) ---------------- */
const ppBlock = (yml.split(/\n\s+- name:/).find((b) => /Publish the HEALTHY lineage-proven subset/.test(b.split("\n")[0] || "")) || "");
const pfBlock = (yml.split(/\n\s+- name:/).find((b) => /Partial-cycle preflight/.test(b.split("\n")[0] || "")) || "");
const partialNotice = steps.find((s) => /Report a PARTIAL publication/.test(s.name));

ok("the partial_preflight step passes the proposed eligible_ids + the effective as-of to the read-only lineage preflight",
  /priority-partial-preflight\.mjs --bucket=\$\{\{ steps\.cfg\.outputs\.region \}\} --eligible-accounts=\$\{\{ steps\.oli\.outputs\.eligible_ids \}\} --as-of=\$\{\{ steps\.readiness\.outputs\.effective_asof \}\}/.test(pfBlock));
ok("partial_publish uses the REFINED partial_preflight.outputs.eligible_ids (NOT the raw OLI list)",
  /--eligible-accounts=\$\{\{ steps\.partial_preflight\.outputs\.eligible_ids \}\}/.test(ppBlock) && !/--eligible-accounts=\$\{\{ steps\.oli\.outputs\.eligible_ids \}\}/.test(ppBlock));
ok("the PARTIAL publication notice fires ONLY on a successful partial_publish (gated on partial_publish.outcome == 'success')",
  partialNotice && /steps\.partial_publish\.outcome == 'success'/.test(partialNotice.cond));
ok("the PARTIAL publication notice reports the REFINED counts (published = partial_preflight.eligible_count; lineage_deferred present)",
  /published=\$\{\{ steps\.partial_preflight\.outputs\.eligible_count \}\}/.test(yml) && /lineage_deferred=\$\{\{ steps\.partial_preflight\.outputs\.deferred_count \}\}/.test(yml));

/* ---------------- SCENARIO: some proven -> publish the exact refined subset ---------------- */
{
  const c = S({ "steps.oli.outputs.full_complete": "false", "steps.partial_preflight.outcome": "success", "steps.partial_publish.outcome": "success" });
  ok("SOME-PROVEN: preflight ok -> full_controls opens + partial_publish runs (publishing EXACTLY the refined subset)", evalIf(CTL, c) === true && evalIf(PP, c) === true);
  ok("SOME-PROVEN: the PARTIAL publication notice fires (a real publication happened)", evalIf(partialNotice.cond, c) === true);
}
/* ---------------- SCENARIO: ALL DEFERRED (lineage preflight leaves zero eligible -> exits nonzero) ---------------- */
{
  // The lineage preflight exiting nonzero (all-deferred OR evidence-unreadable) => partial_preflight.outcome=failure.
  const c = S({ "steps.oli.outputs.full_complete": "false", "steps.partial_preflight.outcome": "failure", "steps.partial_publish.outcome": "skipped", "steps.campaign.outcome": "failure" });
  ok("ALL-DEFERRED: full_controls does NOT open (no controls)", evalIf(CTL, c) === false);
  ok("ALL-DEFERRED: partial_publish does NOT run (no publish)", evalIf(PP, c) === false);
  ok("ALL-DEFERRED: the PARTIAL publication (success) notice does NOT fire", evalIf(partialNotice.cond, c) === false);
  ok("ALL-DEFERRED: the Campaign 'sales PUBLISHED' notice does NOT fire (no false-green publication claim)", evalIf(NA, c) === false);
  ok("ALL-DEFERRED: the honest 'incomplete/unverified' Campaign notice fires instead", evalIf(NB, c) === true);
}
/* ---------------- SCENARIO: evidence UNREADABLE at preflight -> identical fail-closed outcome ---------------- */
{
  const c = S({ "steps.oli.outputs.full_complete": "false", "steps.partial_preflight.outcome": "failure", "steps.partial_publish.outcome": "skipped" });
  ok("UNREADABLE-EVIDENCE: same fail-closed shape (no controls, no publish, no success notice)", evalIf(CTL, c) === false && evalIf(PP, c) === false && evalIf(partialNotice.cond, c) === false);
}
/* ---------------- SCENARIO: successful publish + readback -> success notice ONLY then ---------------- */
{
  const cOk = S({ "steps.oli.outputs.full_complete": "false", "steps.partial_preflight.outcome": "success", "steps.partial_publish.outcome": "success" });
  const cFail = S({ "steps.oli.outputs.full_complete": "false", "steps.partial_preflight.outcome": "success", "steps.partial_publish.outcome": "failure" });
  ok("SUCCESS-ONLY-THEN: the PARTIAL publication notice fires on partial_publish success (publish + readback proven by the step's own exit code)", evalIf(partialNotice.cond, cOk) === true);
  ok("SUCCESS-ONLY-THEN: it does NOT fire when partial_publish (which includes the exact live readback) failed", evalIf(partialNotice.cond, cFail) === false);
}

writeSync(1, `\nscheduler-partial-publication-ordering: ${passed} checks passed\n`);
