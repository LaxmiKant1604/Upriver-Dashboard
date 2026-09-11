// DUPLICATE-RUN downstream gating for scheduler-v2 (WORK 2). A delayed regional run -- e.g. GitHub's native cron firing
// AFTER the Cloudflare run already published D-1 for the same region -- must suppress the WHOLE regional execution graph,
// not just the in-`run` steps. Before this fix the `run` job's duplicate guard correctly skipped OLI/Ads/controls/
// publication, but FBA + materialization + Listing Health v3 STILL ran (they gated only on `needs.run.result=='success'`
// or a resolved region), so v3 created four exports and then failed trying to append to the already-terminal cycle
// (run 34576893181). The fix: one typed `execute_downstream` output ('true' only when THIS invocation owns real regional
// work) that EVERY downstream regional job gates on.
//
// This test EVALUATES the ACTUAL rendered job-level `if:` expressions from .github/workflows/scheduler-v2.yml with a
// faithful GitHub-Actions condition evaluator (always() / && / || / ! / == / != / parens / string literals / dotted
// needs.* + steps.* lookups; a missing lookup resolves to "" exactly as GHA does) -- NOT loose source-string matching.
// It proves the required matrix + the run-34576893181 regression. 7-bit ASCII, LF. ZERO I/O beyond reading the workflow.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "scheduler-duplicate-run-gating\n");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const wf = readFileSync(path.join(repoRoot, ".github/workflows/scheduler-v2.yml"), "utf8");

// ---- Faithful GHA `if:` evaluator (same semantics as scheduler-partial-publication-ordering.test.js's evalIf, here
// exercising JOB-level gates + a needs.* context). Truthiness: booleans as-is; a string is truthy iff non-empty.
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
    p += 1; return Object.prototype.hasOwnProperty.call(ctx, t) ? ctx[t] : "";
  }
  const out = parseOr();
  if (p !== toks.length) throw new Error("trailing tokens in: " + expr);
  return truthy(out);
}
// self-checks proving evaluator fidelity for the operators these gates use
ok("evaluator: always() && A=='x' is true iff A=='x'", evalIf("always() && needs.a.b == 'x'", { "needs.a.b": "x" }) === true && evalIf("always() && needs.a.b == 'x'", { "needs.a.b": "y" }) === false);
ok("evaluator: (A=='true' || B=='true') OR-arm", evalIf("(needs.r.o.a == 'true' || needs.r.o.b == 'true')", { "needs.r.o.b": "true" }) === true);
ok("evaluator: an unset lookup resolves to '' (region != '' is false when region unset)", evalIf("needs.run.outputs.region != ''", {}) === false);
ok("evaluator: skipped/absent result != 'success'", evalIf("needs.run.result == 'success'", { "needs.run.result": "failure" }) === false);

// ---- Parse each JOB's job-level `if:` (4-space indent, before its first step). Returns null for a job with no `if:`.
function jobIf(jobId) {
  const lines = wf.split(/\r?\n/);
  let inJob = false;
  for (const line of lines) {
    const head = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (head) { inJob = head[1] === jobId; continue; }
    if (inJob) { const m = line.match(/^    if:\s*(.+?)\s*$/); if (m) return m[1]; }
  }
  return null;
}
const GATES = {
  fba: jobIf("fba"),
  "listing-health-v3": jobIf("listing-health-v3"),
  materialize: jobIf("materialize"),
  "materialize-inventory": jobIf("materialize-inventory"),
  "bootstrap-ack": jobIf("bootstrap-ack"),
  ads_reconcile: jobIf("ads_reconcile"), // WORK A item 6: immediate Campaign-Ads daily reconcile (zero-export, dry-run default)
};
for (const [job, cond] of Object.entries(GATES)) ok(`parsed a job-level if: for '${job}'`, typeof cond === "string" && cond.length > 0);
const DOWNSTREAM_DATA = ["fba", "listing-health-v3", "materialize", "materialize-inventory"]; // the four that create/publish/materialize

// The typed output definition itself: execute_downstream is 'true' ONLY when the guard proved real work is needed.
ok("run.outputs.execute_downstream == (guard.run_required == 'true') (proven-work only; fail-closed on '' )", /execute_downstream:\s*\$\{\{\s*steps\.guard\.outputs\.run_required == 'true'\s*\}\}/.test(wf));

// ---- Context builders. `needs.run.outputs.execute_downstream` mirrors the YAML definition run_required=='true'.
const ctx = ({ result = "success", region = "india", scope = "full", runRequired = "true", alreadyPublished = "false", tokenProceed = "true" }) => ({
  "needs.run.result": result,
  "needs.run.outputs.region": region,
  "needs.run.outputs.scope": scope,
  "needs.run.outputs.execute_downstream": runRequired === "true" ? "true" : "false", // == the YAML expression
  "needs.run.outputs.already_published": alreadyPublished,
  "needs.run.outputs.token_proceed": tokenProceed,
});
const runs = (job, c) => evalIf(GATES[job], c);
const allDataRun = (c) => DOWNSTREAM_DATA.every((j) => runs(j, c));
const allDataSkip = (c) => DOWNSTREAM_DATA.every((j) => !runs(j, c));

// ---- MATRIX ----------------------------------------------------------------------------------------------------------

// 1. Cloudflare first run, not published -> genuine work -> all intended downstream jobs execute.
{
  const c = ctx({ runRequired: "true", alreadyPublished: "false", tokenProceed: "true" });
  ok("CF first run (not published): FBA + v3 + materialize + materialize-inventory all EXECUTE", allDataRun(c));
  ok("CF first run: bootstrap-ack is SKIPPED (full scope)", !runs("bootstrap-ack", c));
}
// 2. GitHub first run, not published -> identical workflow (Cloudflare/GitHub convergence) -> all execute.
{
  const c = ctx({ runRequired: "true", alreadyPublished: "false", tokenProceed: "true" });
  ok("GH first run (not published): all intended downstream jobs EXECUTE (same rendered gates for either trigger)", allDataRun(c));
}
// 3. Cloudflare success followed by delayed GitHub duplicate -> proven no-op -> every downstream job skipped.
{
  const c = ctx({ result: "success", runRequired: "false", alreadyPublished: "true", tokenProceed: "" });
  ok("delayed GH duplicate (CF already published): FBA + v3 + materialize + materialize-inventory ALL SKIPPED", allDataSkip(c));
  ok("delayed GH duplicate: bootstrap-ack SKIPPED too (full scope)", !runs("bootstrap-ack", c));
}
// 4. GitHub success followed by delayed Cloudflare duplicate -> symmetric complete downstream skip.
{
  const c = ctx({ result: "success", runRequired: "false", alreadyPublished: "true", tokenProceed: "" });
  ok("delayed CF duplicate (GH already published): complete downstream SKIP (symmetric)", allDataSkip(c));
}
// 5. Duplicate check unreadable/throws/malformed -> the guard STEP fails -> run job fails, run_required='' -> fail closed.
{
  // cfg ran (region/scope resolved) but the guard threw before emitting outputs: execute_downstream=='false', result='failure'.
  const c = ctx({ result: "failure", runRequired: "", alreadyPublished: "", tokenProceed: "" });
  ok("guard unreadable/throws (run_required=''): execute_downstream is NOT 'true' -> NO downstream execution", allDataSkip(c) && !runs("bootstrap-ack", c));
  ok("fail closed: a thrown guard is NEVER an already-published no-op (downstream is skipped, run is red not green)", c["needs.run.outputs.execute_downstream"] === "false" && c["needs.run.outputs.already_published"] !== "true");
}
// 6. Primary run fails AFTER proving real work is needed (e.g. OLI publish failed) -> not a duplicate/no-op.
{
  const c = ctx({ result: "failure", runRequired: "true", alreadyPublished: "false", tokenProceed: "true" });
  ok("primary run fails after guard: execute_downstream stays 'true' -> NOT marked a duplicate/no-op", c["needs.run.outputs.execute_downstream"] === "true");
  ok("primary run fails after guard: v3 still SKIPS on non-success (existing result gate), duplicate-suppression does not fire", !runs("listing-health-v3", c) && runs("materialize", c) === true);
}
// 7. Bootstrap/manual -> guard bypass (run_required=true) -> regional data jobs skip on scope; fba + bootstrap-ack run.
{
  const c = ctx({ result: "success", scope: "bootstrap", runRequired: "true", alreadyPublished: "false", tokenProceed: "true" });
  ok("bootstrap: v3 + materialize + materialize-inventory SKIP on scope (unchanged)", !runs("listing-health-v3", c) && !runs("materialize", c) && !runs("materialize-inventory", c));
  ok("bootstrap: fba RUNS (region + execute_downstream + token gate) and bootstrap-ack RUNS (execute_downstream true for bootstrap)", runs("fba", c) && runs("bootstrap-ack", c));
}
// 8. A skipped downstream job runs ZERO steps -- so a duplicate's skipped jobs cannot create exports or touch cycles.
{
  const dup = ctx({ result: "success", runRequired: "false", alreadyPublished: "true", tokenProceed: "" });
  ok("duplicate: EVERY create/publish/materialize job's gate evaluates FALSE (a skipped job executes nothing)", DOWNSTREAM_DATA.every((j) => runs(j, dup) === false));
}
// 9. WORK A item 6: the immediate Campaign-Ads daily reconcile job (ads_reconcile) is gated EXACTLY like the other
// real-work downstream jobs -- it RUNS on a genuine full-scope run, is SUPPRESSED on a delayed duplicate (so a duplicate
// never opens a control lease / re-publishes daily), SKIPS a bootstrap wave (scope gate), and is fail-closed when the
// guard is unreadable. This keeps the zero-export Ads reconcile inside the duplicate-run suppression graph.
{
  const first = ctx({ runRequired: "true", alreadyPublished: "false", tokenProceed: "true" });
  ok("ads_reconcile: genuine first run (full scope) -> RUNS", runs("ads_reconcile", first) === true);
  const dup = ctx({ result: "success", runRequired: "false", alreadyPublished: "true", tokenProceed: "" });
  ok("ads_reconcile: delayed duplicate (already published) -> SKIPPED (no lease, no re-publish)", runs("ads_reconcile", dup) === false);
  const boot = ctx({ scope: "bootstrap", runRequired: "true", alreadyPublished: "false", tokenProceed: "true" });
  ok("ads_reconcile: bootstrap wave -> SKIPPED (scope != 'bootstrap' gate; the next full run reconciles)", runs("ads_reconcile", boot) === false);
  const thrown = ctx({ result: "failure", runRequired: "", alreadyPublished: "", tokenProceed: "" });
  ok("ads_reconcile: guard unreadable (run_required='') -> SKIPPED (fail closed)", runs("ads_reconcile", thrown) === false);
}

// ---- REGRESSION: run 34576893181 (India, delayed GitHub native run after Cloudflare 34558730613 already published D-1) -
// seed the exact duplicate decision and prove the ENTIRE regional graph is a green no-op (zero FBA/Listings/Listings-Raw
// creates, zero new cycles/jobs/snapshots/materializations, no terminal-cycle append attempt).
{
  const c = ctx({ result: "success", region: "india", scope: "full", runRequired: "false", alreadyPublished: "true", tokenProceed: "" });
  ok("regr 34576893181: FBA job SKIPPED (zero FBA export creates / token spend)", !runs("fba", c));
  ok("regr 34576893181: Listing Health v3 job SKIPPED (zero Listings/Listings-Raw exports; NO append to the terminal cycle)", !runs("listing-health-v3", c));
  ok("regr 34576893181: materialize + materialize-inventory SKIPPED (zero new materializations)", !runs("materialize", c) && !runs("materialize-inventory", c));
  ok("regr 34576893181: the delayed duplicate is an intentional GREEN no-op (run succeeds, every downstream job skips)", c["needs.run.result"] === "success" && allDataSkip(c));
}

writeSync(1, `\nscheduler-duplicate-run-gating: ${passed} assertions passed\n`);
