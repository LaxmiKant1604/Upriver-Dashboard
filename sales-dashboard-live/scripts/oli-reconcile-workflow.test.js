// Workflow shape/condition guard for the zero-export OLI reconciler (WORK 7 + WORK 6 + WORK 13). Parses the new
// oli-publication-reconcile.yml and the immediate step added to scheduler-v2.yml. Offline; text assertions. 7-bit ASCII.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "oli-reconcile-workflow\n");

const wf = readFileSync(new URL("../../.github/workflows/oli-publication-reconcile.yml", import.meta.url), "utf8");
const sched = readFileSync(new URL("../../.github/workflows/scheduler-v2.yml", import.meta.url), "utf8");

// ---- oli-publication-reconcile.yml (WORK 7) ----
ok("runs one daily recovery pass after all scheduler windows", /- cron: "13 20 \* \* \*"/.test(wf));
ok("disabled scheduled recovery allocates no runner; manual dispatch remains available", /if: github\.event_name == 'workflow_dispatch' \|\| vars\.OLI_RECONCILE_LIVE == 'true'/.test(wf));
ok("workflow_dispatch mode defaults to dry-run (live must be explicitly chosen)", /mode:[\s\S]{0,200}default: "dry-run"[\s\S]{0,120}options:[\s\S]{0,60}- dry-run[\s\S]{0,20}- live/.test(wf));
ok("least-privilege permissions: contents: read and NO actions: write (no GitHub dispatch)", /permissions:[\s\S]{0,200}contents: read/.test(wf) && !/actions: write/.test(wf));
// CAPACITY (blocker 6): ONE job (one checkout + one npm ci) loops the 3 regions IN ORDER, each capped, so the whole
// pass stays bounded. The global control lease means regions must run SEQUENTIALLY.
ok("ONE job loops the 3 regions in order (no matrix; the global lease forbids parallel regions)", /for REGION in india europe-au us-ca/.test(wf) && !/strategy:/.test(wf) && !/matrix:/.test(wf));
ok("each region is hard-capped (timeout 420s) so one region can never consume the whole budget", /timeout 420 node scripts\/release\/oli-publication-reconcile\.mjs --bucket="\$REGION"/.test(wf));
ok("the job timeout is bounded and a per-region failure is isolated (loop continues)", /timeout-minutes: 25/.test(wf) && /isolated; continuing/.test(wf));
ok("single concurrency group + cancel-in-progress false (a delayed tick queues; the tight cap prevents backlog)", /group: oli-publication-reconcile\b/.test(wf) && /cancel-in-progress: false/.test(wf));
ok("DEFAULT is dry-run: --live only on a manual live dispatch OR when vars.OLI_RECONCILE_LIVE=='true'", /vars\.OLI_RECONCILE_LIVE == 'true' && 'live' \|\| 'dry-run'/.test(wf));
ok("periodic mode + as-of is a conservative D-1 (yesterday UTC)", /--mode=periodic\b/.test(wf) && /date -u -d 'yesterday' \+%F/.test(wf));
ok("it installs deps (real report work) but references NO DataDoe export/token symbol (zero export)", /npm ci/.test(wf) && !/createExport|reserveTokens|exportsCreate|--force-latest/.test(wf));
ok("it verifies required secrets fail-closed and never prints them", /missing required secret/.test(wf) && /POSTGRES_URL SUPABASE_SERVICE_ROLE_KEY DATADOE_API_KEY/.test(wf));
// blocker 5: cooperative deadline (reserve cleanup time within the 420s cap) so the in-flight account is bounded and the
// safe-close runs BEFORE the hard kill; PLUS a SEPARATE cleanup JOB (needs: reconcile, if: always()) that survives the
// reconcile job's own timeout/cancellation (a same-job step would be killed with it) and reclaims + proves closed any
// controls a killed/timed-out region left open, making the run NON-GREEN when cleanup can't be verified.
ok("(blocker 5) the reconcile passes --deadline-seconds (below the 420s hard cap) so the in-flight op is bounded + safe-close runs before a kill", /--deadline-seconds=330/.test(wf) && /timeout 420 node/.test(wf));
ok("(blocker 5) the reconcile job exposes asof/only/mode outputs the cleanup job consumes", /outputs:[\s\S]{0,120}asof: \$\{\{ steps\.reconcile\.outputs\.asof \}\}[\s\S]{0,120}mode: \$\{\{ steps\.reconcile\.outputs\.mode \}\}/.test(wf));
ok("(blocker 5) a SEPARATE cleanup JOB (needs: reconcile, if: always()) survives the reconcile job's timeout/cancellation", /\n  cleanup:\n/.test(wf) && /needs: reconcile\b/.test(wf) && /\n    if: always\(\) && /.test(wf));
ok("(blocker 5) the cleanup job reclaims controls left open by an abnormal termination (per region, --cleanup)", /--mode=periodic --cleanup\b/.test(wf) && /reclaim/.test(wf.toLowerCase()));
ok("(blocker 5) the workflow is NON-GREEN when a region's control cleanup cannot be verified", /OLI_RECONCILE_CLEANUP_UNVERIFIED/.test(wf) && /exit \$rc/.test(wf));

// ---- lease-strand fix: the reconcile SCRIPT reserves start-time before the hard deadline (so the last in-flight derive
// completes + safe-close runs before deadlineRace would abort it -> the lease never strands -> the next region never
// defers on CONTROL_LEASE_HELD; the india->us-ca cascade observed in run 35662300118). Guards the SCRIPT source. ----
const recSrc = readFileSync(new URL("./release/oli-publication-reconcile.mjs", import.meta.url), "utf8");
ok("(lease-strand) the script defines a positive START_RESERVE_SEC (stop starting new derives before the hard deadline)", /const START_RESERVE_SEC = (\d+)/.test(recSrc) && Number((recSrc.match(/const START_RESERVE_SEC = (\d+)/) || [])[1]) > 0);
ok("(lease-strand) outOfTime() trips at the start-cutoff (deadline - reserve), NOT at the raw deadline (reserves time for the last derive + safe-close)", /startCutoffSec = deadlineSec > 0 \?[^\n]*deadlineSec - START_RESERVE_SEC/.test(recSrc) && /outOfTime = \(\) => deadlineSec > 0 && \(Date\.now\(\) - runStartMs\) \/ 1000 > startCutoffSec/.test(recSrc));
ok("(lease-strand) the reserve is a no-op when no deadline is set (immediate/unbounded local runs unaffected)", /deadlineSec > 0 \?[^\n]*deadlineSec - START_RESERVE_SEC\) : 0/.test(recSrc));
// FOOTGUN GUARD: a deadline <= START_RESERVE_SEC must NOT collapse the start-cutoff to 0 (which would defer every
// account and publish nothing). The formula keeps at least half the budget as a publish window.
ok("(lease-strand) a small --deadline-seconds cannot defer everything: startCutoff keeps >= half the budget", /Math\.max\(Math\.floor\(deadlineSec \/ 2\), deadlineSec - START_RESERVE_SEC\)/.test(recSrc));
// The reserve MUST be strictly less than the workflow's --deadline-seconds, else the reconcile would defer EVERY account
// (never publish). Cross-check the constant against the YAML's cap so the two can never drift into a no-publish state.
const wfDeadline = Number((wf.match(/--deadline-seconds=(\d+)/) || [])[1]);
const reserve = Number((recSrc.match(/const START_RESERVE_SEC = (\d+)/) || [])[1]);
ok("(lease-strand) START_RESERVE_SEC leaves a positive publish window under the workflow deadline (reserve < deadline)", wfDeadline > 0 && reserve > 0 && reserve < wfDeadline);

// ---- defect 2: the cleanup-job gate must EVALUATE identically to the reconcile job's effective-mode==live decision ----
// A manual DRY-RUN must be zero-write: cleanup must NOT run even when vars.OLI_RECONCILE_LIVE=='true' (the repo flag
// decides SCHEDULED runs only). We EXTRACT both GitHub-Actions expressions from the YAML and EVALUATE them (not a
// source-string match) across the full 2x2x2 truth table, asserting cleanup runs IFF the effective mode is 'live'.
function ghaToJs(expr) {
  let js = String(expr)
    .replace(/always\(\)/g, "true")
    .replace(/github\.event_name/g, "ctx.event_name")
    .replace(/github\.event\.inputs\.mode/g, "ctx.inputs_mode")
    .replace(/vars\.OLI_RECONCILE_LIVE/g, "ctx.oli_live");
  js = js.replace(/!=/g, "!==").replace(/([^!<>=])==/g, "$1===");
  return js;
}
function ghaEval(expr, ctx) { return Function("ctx", "return (" + ghaToJs(expr) + ");")(ctx); }
// The reconcile step's effective MODE (the `${{ ... }}` inside MODE='...').
const modeExpr = (wf.match(/MODE='\$\{\{\s*([\s\S]*?)\s*\}\}'/) || [])[1];
ok("(defect 2) the reconcile MODE expression is present", typeof modeExpr === "string" && /event_name/.test(modeExpr));
// The cleanup job's `if:` (the whole condition, including the always() && prefix).
const cleanupIf = (wf.match(/\n  cleanup:\n[\s\S]*?\n    if: (.*)/) || [])[1];
ok("(defect 2) the cleanup job if-condition is present", typeof cleanupIf === "string" && /event_name/.test(cleanupIf));
const TRUTH = [
  { name: "manual dry-run (flag=true) -> NOT live -> NO cleanup (zero-write preserved)", ctx: { event_name: "workflow_dispatch", inputs_mode: "dry-run", oli_live: "true" }, live: false },
  { name: "manual live -> live -> cleanup runs", ctx: { event_name: "workflow_dispatch", inputs_mode: "live", oli_live: "false" }, live: true },
  { name: "scheduled + flag true -> live -> cleanup runs", ctx: { event_name: "schedule", inputs_mode: "", oli_live: "true" }, live: true },
  { name: "scheduled + flag false -> NOT live -> NO cleanup", ctx: { event_name: "schedule", inputs_mode: "", oli_live: "false" }, live: false },
];
for (const row of TRUTH) {
  const effLive = ghaEval(modeExpr, row.ctx) === "live";
  const cleanupRuns = ghaEval(cleanupIf, row.ctx) === true;
  ok("(defect 2) " + row.name, effLive === row.live && cleanupRuns === row.live && cleanupRuns === effLive);
}

// ---- scheduler-v2.yml immediate post-save reconcile step (WORK 6 + blocker 2) ----
const stepStart = sched.indexOf("Immediate OLI publication reconcile");
ok("scheduler-v2.yml has the immediate post-save reconcile step", stepStart > 0);
const step = sched.slice(stepStart, stepStart + 1100);
ok("the immediate step is additive: continue-on-error (never changes the scheduler's own outcome)", /continue-on-error: true/.test(step));
ok("it runs BEFORE safe-close, gated on full_controls having emitted a generation (the fence is still open)", /steps\.full_controls\.outputs\.generation != ''/.test(step));
ok("(blocker 2) it REUSES the scheduler's exact fence: --run-token + the full_controls --owner-generation", /--run-token=\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/.test(step) && /--owner-generation=\$\{\{ steps\.full_controls\.outputs\.generation \}\}/.test(step));
ok("it reconciles EXACTLY the OLI-eligible accounts at the effective as-of, in immediate mode", /--mode=immediate --accounts=\$\{\{ steps\.oli\.outputs\.eligible_ids \}\}/.test(step) && /--as-of=\$\{\{ steps\.readiness\.outputs\.effective_asof \}\}/.test(step));
ok("it is DRY-RUN unless the repository variable OLI_RECONCILE_LIVE=='true'", /if \[ "\$\{\{ vars\.OLI_RECONCILE_LIVE \}\}" = "true" \]; then LIVE="--live"/.test(step));
ok("it invokes the SAME reconciler entrypoint as the periodic backstop (one implementation)", /node scripts\/release\/oli-publication-reconcile\.mjs --bucket=\$\{\{ steps\.cfg\.outputs\.region \}\}/.test(step));
ok("the immediate step NEVER creates a DataDoe export/token (zero export)", !/createExport|reserveTokens|exportsCreate|--force-latest/.test(step));

writeSync(1, `\noli-reconcile-workflow: ${passed} assertions passed\n`);
