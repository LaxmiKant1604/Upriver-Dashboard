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
ok("runs every 30 minutes, OFFSET off the hour/half-hour boundary (13,43)", /- cron: "13,43 \* \* \* \*"/.test(wf));
ok("workflow_dispatch mode defaults to dry-run (live must be explicitly chosen)", /mode:[\s\S]{0,200}default: "dry-run"[\s\S]{0,120}options:[\s\S]{0,60}- dry-run[\s\S]{0,20}- live/.test(wf));
ok("least-privilege permissions: contents: read and NO actions: write (no GitHub dispatch)", /permissions:[\s\S]{0,200}contents: read/.test(wf) && !/actions: write/.test(wf));
// CAPACITY (blocker 6): ONE job (one checkout + one npm ci) loops the 3 regions IN ORDER, each capped, so the whole
// pass finishes well inside the 30-minute tick. The global control lease means regions must run SEQUENTIALLY.
ok("ONE job loops the 3 regions in order (no matrix; the global lease forbids parallel regions)", /for REGION in india europe-au us-ca/.test(wf) && !/strategy:/.test(wf) && !/matrix:/.test(wf));
ok("each region is hard-capped (timeout 420s) so one region can never consume the whole budget", /timeout 420 node scripts\/release\/oli-publication-reconcile\.mjs --bucket="\$REGION"/.test(wf));
ok("the job timeout (25 min) fits inside the 30-minute tick; a per-region failure is isolated (loop continues)", /timeout-minutes: 25/.test(wf) && /isolated; continuing/.test(wf));
ok("single concurrency group + cancel-in-progress false (a delayed tick queues; the tight cap prevents backlog)", /group: oli-publication-reconcile\b/.test(wf) && /cancel-in-progress: false/.test(wf));
ok("DEFAULT is dry-run: --live only on a manual live dispatch OR when vars.OLI_RECONCILE_LIVE=='true'", /vars\.OLI_RECONCILE_LIVE == 'true' && 'live' \|\| 'dry-run'/.test(wf));
ok("periodic mode + as-of is a conservative D-1 (yesterday UTC)", /--mode=periodic\b/.test(wf) && /date -u -d 'yesterday' \+%F/.test(wf));
ok("it installs deps (real report work) but references NO DataDoe export/token symbol (zero export)", /npm ci/.test(wf) && !/createExport|reserveTokens|exportsCreate|--force-latest/.test(wf));
ok("it verifies required secrets fail-closed and never prints them", /missing required secret/.test(wf) && /POSTGRES_URL SUPABASE_SERVICE_ROLE_KEY DATADOE_API_KEY/.test(wf));
// blocker 5: cooperative deadline (reserve cleanup time within the 420s cap) + an ALWAYS cleanup step that reclaims any
// controls a killed/timed-out region left open, making the run NON-GREEN when cleanup can't be verified.
ok("(blocker 5) the reconcile passes --deadline-seconds (below the 420s hard cap) so safe-close runs before a kill", /--deadline-seconds=330/.test(wf) && /timeout 420 node/.test(wf));
ok("(blocker 5) an ALWAYS cleanup step reclaims controls left open by an abnormal termination", /if: always\(\) && steps\.reconcile\.outputs\.mode == 'live'/.test(wf) && /--cleanup\b/.test(wf) && /reclaim/.test(wf.toLowerCase()));
ok("(blocker 5) the workflow is NON-GREEN when a region's control cleanup cannot be verified", /OLI_RECONCILE_CLEANUP_UNVERIFIED/.test(wf) && /exit \$rc/.test(wf));

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
