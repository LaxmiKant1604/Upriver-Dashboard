// scheduler-v2 ROUTE SWITCH -- publication recovery WP13 (plan-addendum revision WP13; HANDOFF.md 'WP13 addenda').
//
// Pins the scheduler cutover that retires every legacy UNFENCED writer of a route-owned live report key:
//   A. the scheduler-v2 `materialize` / `materialize-inventory` jobs call the FENCED zero-export route CLI
//      UNCONDITIONALLY (--mode=scheduler --live --run-token=<unique> --lease-wait-seconds=600 --emit-targets, the runtime
//      zero-export guard preloaded through NODE_OPTIONS --import, an always() --cleanup with the SAME run token); there is
//      NO legacy write step, NO brand-inventory rebuild and NO switch flag; the owner attestation variables reach only the
//      job that needs them; the exact workflow argv parses through the real route-CLI parser;
//   B. ACQUISITION BYTE-IDENTITY: every other job (header, run, fba, ads_reconcile, listing-health-v3,
//      listing_health_v3_reconcile, bootstrap-ack) equals its 6a59a1f text EXACTLY once the allow-listed WP13 hunks are
//      reverted (control-envelope --lease-wait-seconds=600 suffixes, comments, the LHv3 typed-outcome plumbing). Proven by
//      PINNED sha256 digests of the 6a59a1f job blocks (works with no git history) AND, when the commit is reachable, by a
//      direct text comparison against `git show 6a59a1f:.github/workflows/scheduler-v2.yml`;
//   C. lease-wait default 0 is BYTE-IDENTICAL (no leaseWaitSeconds key reaches runControlPackageCli; the fba-plan apply
//      argument shape is exactly the pre-WP13 one); malformed bounds fail closed;
//   D. the retired backfills (brand-sales, daily-v2, daily-named-brands, sku-movement) are inert exit-2 stubs -- proven
//      STATICALLY and by evaluating each in a vm sandbox that has no module loader, no env and no I/O (a CLI entrypoint is
//      NEVER spawned: a reverted stub would load .env.local and reach production, so it must fail here with zero I/O);
//   E. the retired materializers write nothing: the CLIs refuse --mode=live (and the rebuild's --inventory-as-of) BEFORE
//      loadReleaseEnv / any dynamic import; the compositions bind no writer / lock / publish; the operator cores refuse a
//      live run without persistSnapshot; nothing outside tests calls the brand-inventory rebuild;
//   F. the scheduler-v1 LIBRARY (run-sync.js + report-adapter.js) refuses EVERY route-owned key itself -- typed
//      ROUTE_OWNED_REPORT_V1_REFUSED (409) with zero fetch / build / save / prune / publish -- and still serves the
//      manual-paid keys;
//   G. one key set everywhere: the writer-fence keys == report-store's route-owned set == the 20260935 migration seed,
//      and every scheduler route publisher key is route-owned.
// 7-bit ASCII, LF. Offline: reads repo files, runs `git show` (read-only, optional), imports pure modules with injected
// fakes, and stubs globalThis.fetch to a counting refusal. No network, no database, no DataDoe, no CLI execution.

import assert from "node:assert/strict";
import { writeSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "scheduler-v2-route-switch\n");

// Any network attempt from an imported module is a test failure (and never leaves the process).
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls += 1; throw new Error("scheduler-v2-route-switch: network is forbidden in this offline suite"); };

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "..");
const REPO = path.resolve(here, "..", "..");
const lf = (s) => s.replace(/\r\n/g, "\n");
const readApp = (rel) => lf(readFileSync(path.join(APP, rel), "utf8"));
const readRepo = (rel) => lf(readFileSync(path.join(REPO, rel), "utf8"));
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
const count = (s, needle) => s.split(needle).length - 1;

const WF_PATH = ".github/workflows/scheduler-v2.yml";
const wf = readRepo(WF_PATH);

// Split a workflow into { '<header>', <job>... } blocks. A job block starts at its `  <name>:` key line, walked back over
// the contiguous comment lines that document it, and ends where the next job block starts.
function splitJobs(txt) {
  const L = txt.split("\n");
  const jobsAt = L.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(jobsAt > 0, "workflow has a jobs: key");
  const heads = [];
  for (let i = jobsAt + 1; i < L.length; i++) { const m = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(L[i]); if (m) heads.push({ name: m[1], at: i }); }
  const starts = heads.map((h) => { let s = h.at; while (s - 1 > jobsAt && /^\s*#/.test(L[s - 1])) s--; return s; });
  const out = new Map([["<header>", L.slice(0, starts[0]).join("\n")]]);
  heads.forEach((h, k) => out.set(h.name, L.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : L.length).join("\n")));
  return out;
}
const JOBS = splitJobs(wf);
const job = (name) => { const b = JOBS.get(name); assert.ok(typeof b === "string" && b.length > 0, "job " + name + " exists"); return b; };
// A job's `- name:` steps (each step from its `      - ` line to the next one at the same indent).
function stepsOf(block) {
  const L = block.split("\n"); const idx = [];
  L.forEach((l, i) => { if (/^ {6}- /.test(l)) idx.push(i); });
  return idx.map((s, k) => L.slice(s, k + 1 < idx.length ? idx[k + 1] : L.length).join("\n"));
}
const stepNamed = (block, re) => { const hits = stepsOf(block).filter((s) => re.test(s.split("\n")[0])); assert.equal(hits.length, 1, "exactly one step matching " + re); return hits[0]; };
const runLinesOf = (step) => step.split("\n").map((l) => l.trim()).filter((l) => /^(run: )?node scripts\/release\/publication-route-reconcile\.mjs /.test(l)).map((l) => l.replace(/^run: /, ""));

/* ============================== A. the materialize jobs call the FENCED route CLI unconditionally ============================== */
const ROUTE_CLI = "scripts/release/publication-route-reconcile.mjs";
const GUARD_PRELOAD = 'NODE_OPTIONS: "--import=./lib/server/recovery/zero-export-guard.mjs"';
const MAT = [
  { name: "materialize", routes: "brand-view-brands,sku-movement,returns-v3", needs: "[run, fba]", tokenSuffix: "materialize", publisherKeys: ["brand-view-brands", "sku-movement", "returns-leakage"],
    stepName: "Publish brand-view-brands + sku-movement + returns-v3 through the fenced zero-export route CLI (scheduler mode)",
    extraEnv: ["          SKU_MOVEMENT_SERVE_TOKEN_ATTESTED: ${{ vars.SKU_MOVEMENT_SERVE_TOKEN_ATTESTED }}"] },
  { name: "materialize-inventory", routes: "brand-view,brand-view-portfolio", needs: "[run, fba, materialize]", tokenSuffix: "materialize-inventory", publisherKeys: ["brand-view", "brand-view-portfolio"],
    stepName: "Publish brand-view + brand-view-portfolio through the fenced zero-export route CLI (scheduler mode)", extraEnv: [] },
];
const REGION = "${{ needs.run.outputs.region }}";
const EPOCH = "${{ needs.run.outputs.inventory_asof }}";
const RUN_TOKEN = (suffix) => "${{ github.run_id }}-${{ github.run_attempt }}-" + suffix;
for (const m of MAT) {
  const b = job(m.name);
  const code = b.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"); // YAML minus comment lines
  ok(`A1 ${m.name}: needs ${m.needs}, if: always() on a resolved region, never gated on the fba RESULT, still SKIPPED in bootstrap scope`,
    new RegExp("\\n\\s{4}needs:\\s*" + m.needs.replace(/[[\]]/g, "\\$&") + "\\s*\\n").test(code)
    && /\n\s{4}if: always\(\) && needs\.run\.outputs\.region != '' && needs\.run\.outputs\.execute_downstream == 'true' && needs\.run\.outputs\.scope != 'bootstrap'\s*\n/.test(code)
    && !/needs\.fba\.result/.test(code));
  const route = stepNamed(b, /fenced zero-export route CLI \(scheduler mode\)/);
  const cleanup = stepNamed(b, /Route control cleanup/);
  const liveLines = runLinesOf(route), cleanLines = runLinesOf(cleanup);
  const expectedLive = `node ${ROUTE_CLI} --route=${m.routes} --bucket=${REGION} --as-of=${EPOCH} --mode=scheduler --live --run-token=${RUN_TOKEN(m.tokenSuffix)} --deadline-seconds=3000 --lease-wait-seconds=600 --emit-targets`;
  const expectedClean = `node ${ROUTE_CLI} --route=${m.routes} --bucket=${REGION} --as-of=${EPOCH} --cleanup --run-token=${RUN_TOKEN(m.tokenSuffix)}`;
  // The route step is pinned BYTE FOR BYTE too (its YAML comment lines -- the cleanup step's documentation, which sits
  // between the two steps -- aside): a 'run: |' wrapper with 'set +e' / '|| true' / 'exit 0' would otherwise mask a
  // HARD_FAILURES exit (WP13 round-2 P3-A).
  const expectedRouteStep = [
    "      - name: " + m.stepName,
    "        id: route",
    "        timeout-minutes: 60",
    "        env:",
    "          " + GUARD_PRELOAD,
    ...m.extraEnv,
    "        run: " + expectedLive,
  ].join("\n");
  ok(`A2 ${m.name}: ONE unconditional route step (id route, no if:, NEVER continue-on-error -- a HARD_FAILURES exit must turn the job red) runs EXACTLY the scheduler-mode live route CLI (unique run token, 3000 s deadline, 600 s lease-wait, --emit-targets), bounded by a step timeout -- the step text is EXACTLY the reviewed one`,
    liveLines.length === 1 && liveLines[0] === expectedLive && /\n\s+id: route\n/.test(route) && !/\n\s+if:/.test(route) && /\n\s+timeout-minutes: 60\n/.test(route)
    && !/continue-on-error/.test(code)
    && route.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n").replace(/\n+$/, "") === expectedRouteStep);
  // The cleanup step is pinned BYTE FOR BYTE (a regex over its text can be satisfied by a comment, e.g. 'exit 0 # exit $rc').
  const expectedCleanupStep = [
    "      - name: Route control cleanup (evidence-based safe-close for the same run token; always)",
    "        if: always() && steps.route.outcome != 'skipped'",
    "        timeout-minutes: 10",
    "        env:",
    "          " + GUARD_PRELOAD,
    "        run: |",
    "          set +e",
    "          " + expectedClean,
    "          rc=$?",
    "          if [ \"$rc\" != \"0\" ] && [ \"${{ steps.route.outcome }}\" = \"success\" ]; then",
    "            echo \"::warning::route control cleanup could not prove the plane closed after a SUCCESSFUL route run (its own safe-close was proven) -- another operation holds the lease; left untouched.\"",
    "            exit 0",
    "          fi",
    "          exit $rc",
  ].join("\n");
  ok(`A3 ${m.name}: an always() cleanup step follows it with --cleanup and the SAME run token (never --live), bounded; red on an unprovable plane unless the route step itself succeeded -- the step text is EXACTLY the reviewed one`,
    stepsOf(b).indexOf(cleanup) === stepsOf(b).indexOf(route) + 1 && cleanLines.length === 1 && cleanLines[0] === expectedClean
    && cleanup.replace(/\n+$/, "") === expectedCleanupStep);
  ok(`A4 ${m.name}: the runtime zero-export guard is PRELOADED (NODE_OPTIONS --import) on BOTH the route and the cleanup step`,
    count(route, GUARD_PRELOAD) === 1 && count(cleanup, GUARD_PRELOAD) === 1 && existsSync(path.join(APP, "lib/server/recovery/zero-export-guard.mjs")));
  ok(`A5 ${m.name}: NO legacy materializer, NO brand-inventory rebuild, NO --targets, NO DataDoe export CLI, NO switch flag`,
    !/report-materialization(-brandview)?\.mjs|--inventory-as-of|--skip-inventory-rebuild|runBrandInventoryRebuild/.test(code)
    && !/--targets/.test(code) && !/ingestion\.mjs|fba-plan-golive\.mjs|oli-refresh|campaign-refresh|cron:|schedule:|workflow_dispatch:/.test(code)
    && !/MATERIALIZE_VIA_ROUTES|MATERIALIZE_ROUTES_LIVE|SKIP_INVENTORY_REBUILD/.test(code)
    && count(code, ROUTE_CLI) === 2);
  const jobTimeout = Number((/\n\s{4}timeout-minutes: (\d+)\n/.exec(code) || [])[1]);
  ok(`A6 ${m.name}: the job timeout (${jobTimeout} min) covers the route step (60) + the cleanup (10) + setup`, jobTimeout >= 75);
  for (const id of m.routes.split(",")) {
    ok(`A7 ${m.name}: route '${id}' has BOTH declared modules (the CLI STOPs fail-closed on a missing one)`,
      existsSync(path.join(APP, "lib/server/sync/routes", id + ".release.js")) && existsSync(path.join(APP, "lib/server/recovery/routes", id + ".route.js")));
  }
}
{
  const matCode = job("materialize"), invCode = job("materialize-inventory");
  const tokens = [matCode, invCode].map((b) => (/--run-token=(\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-[a-z-]+)/.exec(b) || [])[1]);
  ok("A8 the two route jobs use DISTINCT run tokens (the control lease owner is derived from the token; two live runs never share it)", tokens[0] && tokens[1] && tokens[0] !== tokens[1]);
  // Every workflow file, YAML comment lines removed (the cutover notes legitimately NAME the retired writers).
  const allWf = readdirSync(path.join(REPO, ".github/workflows")).filter((f) => /\.ya?ml$/.test(f))
    .map((f) => [f, readRepo(".github/workflows/" + f).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n")]);
  ok("A9 NO workflow anywhere invokes the retired materializers, the retired backfills or a MATERIALIZE_VIA_ROUTES / SKIP_INVENTORY_REBUILD flag",
    allWf.every(([, t]) => !/report-materialization(-brandview)?\.mjs|backfill-(brand-sales|daily-v2|daily-named-brands|sku-movement)\.mjs|MATERIALIZE_VIA_ROUTES|MATERIALIZE_ROUTES_LIVE|SKIP_INVENTORY_REBUILD/.test(t)));
  // Owner ATTESTATION variables: exactly the repo variable, only where needed (never a literal 'true' in a workflow).
  const skuHits = wf.split("\n").filter((l) => /SKU_MOVEMENT_SERVE_TOKEN_ATTESTED/.test(l) && !/^\s*#/.test(l));
  const routeStep = stepNamed(matCode, /fenced zero-export route CLI \(scheduler mode\)/);
  ok("A10 SKU_MOVEMENT_SERVE_TOKEN_ATTESTED reaches ONLY the materialize route step, as the repo variable (never hard-coded)",
    skuHits.length === 1 && skuHits[0].trim() === "SKU_MOVEMENT_SERVE_TOKEN_ATTESTED: ${{ vars.SKU_MOVEMENT_SERVE_TOKEN_ATTESTED }}" && routeStep.includes(skuHits[0]));
  const lhv3Hits = wf.split("\n").filter((l) => /LHV3_SERVE_GATE_ATTESTED/.test(l) && !/^\s*#/.test(l));
  ok("A11 LHV3_SERVE_GATE_ATTESTED is set ONLY in the listing-health-v3 job env, as the repo variable; the UI flag LISTING_HEALTH_V3 is NEVER set",
    lhv3Hits.length === 1 && lhv3Hits[0] === "      LHV3_SERVE_GATE_ATTESTED: ${{ vars.LHV3_SERVE_GATE_ATTESTED }}" && job("listing-health-v3").includes(lhv3Hits[0])
    && !/^\s*LISTING_HEALTH_V3\s*:/m.test(wf) && !/LISTING_HEALTH_V3=/.test(wf));
  ok("A12 FBA_PLAN_ROUTE_FENCE_ATTESTED is in NO workflow (the scheduler never runs the fba-plan route; it is a worker / operator env the owner sets after WP10b + the fba-plan fence)",
    allWf.every(([, t]) => !/FBA_PLAN_ROUTE_FENCE_ATTESTED/.test(t)));
  const retWf = readRepo(".github/workflows/returns-leakage.yml");
  ok("A13 returns-leakage.yml is sized for the fenced returns-v3 route (timeout 240 min: up to 4 region chunks x 35 min + the 60 min acquisition, one chunk of headroom) and still runs NO retired writer",
    /\n\s{4}timeout-minutes: 240\n/.test(retWf) && !/report-materialization|backfill-/.test(retWf));
}

// The exact workflow argv through the REAL route-CLI parser (the operator identity of run + cleanup must coincide, so the
// cleanup reclaims only its own run's lease).
{
  const rel = await import("../lib/server/sync/route-publication-release.js");
  const subst = (l) => l.replace(/\$\{\{ needs\.run\.outputs\.region \}\}/g, "india").replace(/\$\{\{ needs\.run\.outputs\.inventory_asof \}\}/g, "2026-09-27")
    .replace(/\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/g, "18123456789-1");
  for (const m of MAT) {
    const b = job(m.name);
    const live = subst(runLinesOf(stepNamed(b, /fenced zero-export route CLI \(scheduler mode\)/))[0]).split(" ").slice(2);
    const clean = subst(runLinesOf(stepNamed(b, /Route control cleanup/))[0]).split(" ").slice(2);
    const L = rel.parseRouteCliArgs(live), C = rel.parseRouteCliArgs(clean);
    ok(`A14 ${m.name}: the workflow's live argv parses: scheduler mode, live, whole region (no targets), 600 s lease-wait (<= the CLI max ${rel.ROUTE_CLI_MAX_LEASE_WAIT_SECONDS}), 3000 s deadline, --emit-targets`,
      L.ok === true && L.args.mode === "scheduler" && L.args.live === true && L.args.dryRun === false && L.args.targets == null && L.args.leaseWaitSeconds === 600
      && 600 <= rel.ROUTE_CLI_MAX_LEASE_WAIT_SECONDS && L.args.deadlineSeconds === 3000 && L.args.emitTargets === true && L.args.cleanup === false
      && JSON.stringify(L.args.routes) === JSON.stringify(m.routes.split(",")) && L.args.bucket === "india" && L.args.asOf === "2026-09-27");
    ok(`A15 ${m.name}: the cleanup argv parses as a cleanup with the SAME run token -> the SAME control-lease operator identity as the live run`,
      C.ok === true && C.args.cleanup === true && C.args.live === false && C.args.runToken === L.args.runToken
      && rel.routeCliOperator({ bucket: C.args.bucket, runToken: C.args.runToken, asOf: C.args.asOf }) === rel.routeCliOperator({ bucket: L.args.bucket, runToken: L.args.runToken, asOf: L.args.asOf }));
  }
}

/* ============================== B. ACQUISITION BYTE-IDENTITY vs 6a59a1f (allow-listed WP13 hunks only) ============================== */
// sha256 of each 6a59a1f job block (LF, the splitJobs boundaries). Reverting EXACTLY the allow-listed hunks below from the
// current block must reproduce it byte for byte. ANY other edit of these jobs -- a fetch step, a batch, a token ceiling,
// the shared Listings reuse, oli-refresh-d1, the campaign refresh, the LHv3 ingestion argv -- fails here until reviewed.
const BASE_COMMIT = "6a59a1f";
const OLD_JOB_SHA256 = {
  "<header>": "5bd4932bbaaf1d56bf30fa28d963d5b052f9f07052b0915bfa6d65daa9e67c32",
  run: "6803f34e80eb8a2bbb621ec95c9a3fbcc60acccec882556dc44cd23108048ba2",
  fba: "9132356051b126c106917cd4c6eb7322043f4d953604692a709d95b6d10d6669",
  ads_reconcile: "e126ec45174e9e2a8e0deac5bc63cd6df37e538dabdd200bbd37dd1fe5d2b7f3",
  "listing-health-v3": "492c678fe1194ee8c37152dc0428ad2da65bb3f38b08b09d12ac2d6f8d42a670",
  listing_health_v3_reconcile: "8667ad229a13fbe75fcdb07027672d054eed6dd9e79e23c12deb307931b726ce",
  "bootstrap-ack": "b49e612e09af9c663400f1067a6f8be4790b7eb909329d2f36fb20512e47731a",
};
// The ONLY permitted WP13 hunks (add = the current lines; del = the 6a59a1f lines they replace; '' = a pure addition).
const ALLOWED_HUNKS = {
  run: [
    { del: "", add: "      # BOUNDED LEASE-WAIT (publication recovery WP13; control envelope ONLY -- acquisition untouched): the global\n      # control-plane lease may be held briefly by a zero-export reconciler / recovery route; --lease-wait-seconds=600\n      # retries the apply ONLY on the typed CONTROL_LEASE_HELD refusal (a zero-write rolled-back transaction), every\n      # 15 s on a fresh connection, for at most 600 s. Any other outcome returns at once (never retries a write that may\n      # have landed). Without the flag the call is byte-identical (exactly one attempt)." },
    { del: "        run: node scripts/release/priority-control-package.mjs --apply --bucket=${{ steps.cfg.outputs.region }} --account-scope=full --owner-token=${{ github.run_id }}-${{ github.run_attempt }}",
      add: "        run: node scripts/release/priority-control-package.mjs --apply --bucket=${{ steps.cfg.outputs.region }} --account-scope=full --owner-token=${{ github.run_id }}-${{ github.run_attempt }} --lease-wait-seconds=600" },
    { del: "        run: node scripts/release/priority-control-package.mjs --apply --bucket=${{ steps.cfg.outputs.region }} --account-scope=bootstrap --dispatch-id=${{ inputs.dispatch_id }} --owner-token=${{ github.run_id }}-${{ github.run_attempt }}",
      add: "        run: node scripts/release/priority-control-package.mjs --apply --bucket=${{ steps.cfg.outputs.region }} --account-scope=bootstrap --dispatch-id=${{ inputs.dispatch_id }} --owner-token=${{ github.run_id }}-${{ github.run_attempt }} --lease-wait-seconds=600" },
  ],
  fba: [
    { del: "", add: "      # --lease-wait-seconds=600 (WP13, control envelope ONLY): each fba-plan control-package APPLY retries on the typed\n      # CONTROL_LEASE_HELD refusal for at most 600 s (the fetch plan, batches, token ceiling and exports are unchanged)." },
    { del: "        run: node scripts/release/fba-plan-golive.mjs --mode=go-live --region=${{ needs.run.outputs.region }} --max-tokens=${{ steps.fcfg.outputs.maxtok }} --inventory-as-of=${{ needs.run.outputs.inventory_asof }} --account-scope=${{ needs.run.outputs.scope }} --dispatch-id=${{ inputs.dispatch_id }} --run-token=${{ github.run_id }}-${{ github.run_attempt }}",
      add: "        run: node scripts/release/fba-plan-golive.mjs --mode=go-live --region=${{ needs.run.outputs.region }} --max-tokens=${{ steps.fcfg.outputs.maxtok }} --inventory-as-of=${{ needs.run.outputs.inventory_asof }} --account-scope=${{ needs.run.outputs.scope }} --dispatch-id=${{ inputs.dispatch_id }} --run-token=${{ github.run_id }}-${{ github.run_attempt }} --lease-wait-seconds=600" },
    // WP13 round-2 P2-A: the fba job's immediate FBA publication reconcile (zero export; NOT acquisition) gains the capped
    // lease-wait for its controls APPLY; publication recovery D3 raises its deadline 300 -> 900 s (same zero-export step).
    { del: "          node scripts/release/fba-publication-reconcile.mjs --bucket=${{ needs.run.outputs.region }} --as-of=${{ needs.run.outputs.inventory_asof }} --mode=periodic --deadline-seconds=300 $LIVE",
      add: "          node scripts/release/fba-publication-reconcile.mjs --bucket=${{ needs.run.outputs.region }} --as-of=${{ needs.run.outputs.inventory_asof }} --mode=periodic --deadline-seconds=900 --lease-wait-seconds=600 $LIVE\n          # ^ --lease-wait-seconds=600 (WP13 verifier P2-A, control envelope ONLY): the controls APPLY retries on the typed\n          # CONTROL_LEASE_HELD refusal (another region's route-CLI materialize may hold the global lease), capped at this\n          # run's start cutoff (deadline 900 s - 120 s reserve); brand-inventory's same-day convergence depends on this step.\n          # --deadline-seconds=900 (publication recovery D3; zero export, NOT acquisition): each stale account is one ~20 s\n          # dedicated fenced release, so the old 300 s (180 s start cutoff) reached only the first 8 of europe-au's 32\n          # accounts; 780 s covers the whole region, and the reconciler's fair order (fbaFairOrder) starts with the\n          # most-starved accounts whenever the deadline still cuts. The fba job's 120-minute timeout is unchanged." },
  ],
  "listing-health-v3": [
    { del: "", add: "    # WP13 (from WP16): the ingestion CLI's typed machine-readable outcome, written to GITHUB_OUTPUT on every normal exit\n    # (NOT on its STOP exits / an uncaught throw -- then both stay EMPTY). The immediate reconcile job below gates on\n    # lhv3_phase so a TYPED failure (a terminal base cycle / a partial) still gets its zero-export publication repair.\n    outputs:\n      lhv3_phase: ${{ steps.ingest.outputs.lhv3_phase }}\n      lhv3_durable_persisted: ${{ steps.ingest.outputs.lhv3_durable_persisted }}" },
    { del: "", add: "      # WP13 (from WP16): the owner ATTESTATION that BOTH Vercel production serve flags (LHV3_PUBLISH_LIVE and the UI flag)\n      # are 'true' -- the ingestion CLI's already-current proof models the served selector ONLY from this repo variable\n      # (exactly 'true'; unset / anything else -> the served check fails CLOSED). This job never sets the UI flag itself.\n      # Owner procedure: change this variable TOGETHER with the Vercel flags.\n      LHV3_SERVE_GATE_ATTESTED: ${{ vars.LHV3_SERVE_GATE_ATTESTED }}" },
    { del: "", add: "      # id `ingest` + continue-on-error (WP13): the step's typed outputs must reach the job outputs even when it exits\n      # nonzero; the NEXT step keeps the job RED on that failure (continue-on-error is sequencing only, never a green)." },
    { del: "", add: "        id: ingest\n        continue-on-error: true" },
    { del: "", add: "      - name: Keep the job red when the Listing Health v3 ingestion failed (its typed phase is already exported)\n        if: steps.ingest.outcome == 'failure'\n        run: |\n          echo \"LISTING_HEALTH_V3_INGESTION_FAILED phase=${{ steps.ingest.outputs.lhv3_phase }} durable_persisted=${{ steps.ingest.outputs.lhv3_durable_persisted }} -- the job stays RED; a typed phase (base-cycle-terminal | partial) still lets the immediate zero-export reconcile repair publication.\" >&2\n          exit 1" },
  ],
  // WP13 verifier P2-1 (lease fairness): the immediate Ads / LHv3 reconcilers' controls APPLY gains a bounded lease-wait
  // (control envelope ONLY; capped by each run's own start cutoff); the explanation sits BELOW the command as shell comments.
  ads_reconcile: [
    { del: "          node scripts/release/ads-publication-reconcile.mjs --bucket=${{ needs.run.outputs.region }} --as-of=${{ needs.run.outputs.effective_asof }} --mode=periodic --deadline-seconds=300 $LIVE",
      add: "          node scripts/release/ads-publication-reconcile.mjs --bucket=${{ needs.run.outputs.region }} --as-of=${{ needs.run.outputs.effective_asof }} --mode=periodic --deadline-seconds=300 --lease-wait-seconds=600 $LIVE\n          # ^ --lease-wait-seconds=600 (WP13 verifier P2-1, control envelope ONLY): the controls APPLY retries on the typed\n          # CONTROL_LEASE_HELD refusal (a concurrent route-CLI materialize holds the global lease in windows), capped at\n          # this run's start cutoff (deadline 300 s - 120 s reserve), instead of deferring every account on one refusal." },
  ],
  listing_health_v3_reconcile: [
    { del: "          node scripts/release/listing-health-v3-reconcile.mjs --bucket=${{ needs.run.outputs.region }} --as-of=${{ needs.run.outputs.inventory_asof }} --mode=periodic --deadline-seconds=720 $LIVE",
      add: "          node scripts/release/listing-health-v3-reconcile.mjs --bucket=${{ needs.run.outputs.region }} --as-of=${{ needs.run.outputs.inventory_asof }} --mode=periodic --deadline-seconds=720 --lease-wait-seconds=600 $LIVE\n          # ^ --lease-wait-seconds=600 (WP13 verifier P2-1, control envelope ONLY): the controls APPLY retries on the typed\n          # CONTROL_LEASE_HELD refusal (a concurrent route-CLI materialize holds the global lease in windows), capped at\n          # this run's start cutoff (deadline 720 s - 120 s reserve), instead of deferring every account on one refusal." },
    { del: "    if: always() && needs.run.outputs.region != '' && needs.run.outputs.execute_downstream == 'true' && needs.run.outputs.scope != 'bootstrap' && needs.run.outputs.inventory_asof != '' && needs.listing-health-v3.result == 'success'",
      add: "    # WP13 EXCEPTION: a TYPED ingestion failure whose phase is base-cycle-terminal or partial (the run's OLI D-1 refresh\n    # advanced the manifest tokens, or one account's shadow save was refused) still runs the reconcile at once; an\n    # ABSENT phase (a STOP exit / a throw) is never eligible -- the plain success gate above applies, exactly as before.\n    if: always() && needs.run.outputs.region != '' && needs.run.outputs.execute_downstream == 'true' && needs.run.outputs.scope != 'bootstrap' && needs.run.outputs.inventory_asof != '' && (needs.listing-health-v3.result == 'success' || contains(fromJSON('[\"base-cycle-terminal\",\"partial\"]'), needs.listing-health-v3.outputs.lhv3_phase))" },
  ],
};
// Revert each hunk on LINE arrays: its `add` lines must occur contiguously EXACTLY ONCE in the block; they are replaced by
// its `del` lines. Returns { text, problems }.
function revertHunks(block, hunks) {
  let L = block.split("\n"); const problems = [];
  for (const h of hunks || []) {
    const add = h.add.split("\n"); const del = h.del === "" ? [] : h.del.split("\n");
    const at = [];
    for (let i = 0; i + add.length <= L.length; i++) if (add.every((l, k) => L[i + k] === l)) at.push(i);
    if (at.length !== 1) { problems.push(`hunk '${add[0].trim().slice(0, 60)}' found ${at.length}x (must be exactly 1)`); continue; }
    L = [...L.slice(0, at[0]), ...del, ...L.slice(at[0] + add.length)];
  }
  return { text: L.join("\n"), problems };
}
let oldWf = null;
try { oldWf = lf(execFileSync("git", ["show", BASE_COMMIT + ":" + WF_PATH], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch { oldWf = null; }
const OLD_JOBS = oldWf ? splitJobs(oldWf) : null;
ok("B0 the guarded job set is EXACTLY every job except materialize / materialize-inventory (a new job must be classified here)",
  JSON.stringify([...JOBS.keys()].filter((k) => k !== "materialize" && k !== "materialize-inventory").sort()) === JSON.stringify(Object.keys(OLD_JOB_SHA256).sort()));
for (const name of Object.keys(OLD_JOB_SHA256)) {
  const { text, problems } = revertHunks(job(name), ALLOWED_HUNKS[name]);
  const digest = sha256(text);
  ok(`B1 ${name}: reverting ONLY its ${(ALLOWED_HUNKS[name] || []).length} allow-listed WP13 hunk(s) reproduces the ${BASE_COMMIT} block byte for byte (pinned sha256)`
    + (problems.length ? " -- " + problems.join("; ") : "") + (digest !== OLD_JOB_SHA256[name] ? " -- DIGEST " + digest : ""),
    problems.length === 0 && digest === OLD_JOB_SHA256[name]);
  if (OLD_JOBS) ok(`B2 ${name}: ... and equals \`git show ${BASE_COMMIT}:${WF_PATH}\` directly`, OLD_JOBS.get(name) === text);
}
if (!OLD_JOBS) writeSync(1, `  (B2 skipped: ${BASE_COMMIT} is not reachable in this clone; the pinned digests in B1 still enforce byte-identity)\n`);
{
  // The guard is FAIL-CLOSED: a one-character acquisition edit, an extra line, or a missing hunk is caught.
  const fba = job("fba");
  const tampered = [
    fba.replace("--max-tokens=${{ steps.fcfg.outputs.maxtok }}", "--max-tokens=999"),
    fba.replace("--lease-wait-seconds=600\n", "--lease-wait-seconds=600 --force-latest\n"),
    fba + "\n      - run: echo extra",
    fba.replace("      # --lease-wait-seconds=600 (WP13, control envelope ONLY)", "      # --lease-wait-seconds=900 (WP13, control envelope ONLY)"),
  ];
  ok("B3 the diff guard is fail-closed: a changed token ceiling, an extra fetch flag, an added step, or an edited hunk all fail it",
    tampered.every((t) => { const r = revertHunks(t, ALLOWED_HUNKS.fba); return r.problems.length > 0 || sha256(r.text) !== OLD_JOB_SHA256.fba; }));
}
{
  // The LHv3 typed-outcome plumbing (the hunks above), semantically: an ABSENT phase is never eligible.
  const v3 = job("listing-health-v3"), rec = job("listing_health_v3_reconcile");
  const list = JSON.parse(((/contains\(fromJSON\('(\[[^\]]*\])'\), needs\.listing-health-v3\.outputs\.lhv3_phase\)/.exec(rec) || [])[1]) || "null");
  ok("B4 LHv3: step id ingest + continue-on-error, then an exit-1 step on its failure (the job stays RED); job outputs expose lhv3_phase / lhv3_durable_persisted; the reconcile runs on success OR a typed phase in exactly [base-cycle-terminal, partial] (never '' -- an absent phase is not eligible)",
    /\n\s+id: ingest\n\s+continue-on-error: true\n\s+run: node scripts\/release\/listing-health-v3-ingestion\.mjs /.test(v3) && /if: steps\.ingest\.outcome == 'failure'\n\s+run: \|\n[^\n]*\n\s+exit 1/.test(v3)
    && /outputs:\n\s+lhv3_phase: \$\{\{ steps\.ingest\.outputs\.lhv3_phase \}\}\n\s+lhv3_durable_persisted: \$\{\{ steps\.ingest\.outputs\.lhv3_durable_persisted \}\}/.test(v3)
    && JSON.stringify(list) === JSON.stringify(["base-cycle-terminal", "partial"]) && !list.includes(""));
}

/* ============================== C. lease-wait default 0 is BYTE-IDENTICAL; malformed bounds fail closed ============================== */
{
  const { buildFbaPlanRelease } = await import("../lib/server/sync/fba-plan-release-composition.js");
  const { MAX_CONTROL_LEASE_WAIT_SECONDS } = await import("../lib/server/sync/source-priority-control-package.js");
  const mk = (extra) => {
    const calls = [];
    const r = buildFbaPlanRelease({
      getConnections: () => [{ id: "primary", apiKey: "x" }], makePublisher: () => ({ preflight: async () => ({}), publish: async () => ({}) }),
      makeRuntime: () => ({}), discoverAccounts: async () => ["A1"], operator: "op",
      runControlPackage: async (a) => { calls.push(a); return { committed: true, code: 0 }; }, ...extra,
    });
    return { r, calls };
  };
  const d = mk({}); await d.r.controls.apply();
  const z = mk({ leaseWaitSeconds: 0 }); await z.r.controls.apply();
  const w = mk({ leaseWaitSeconds: 600 }); await w.r.controls.apply();
  const PRE_WP13_APPLY_KEYS = ["mode", "operator", "discoverAccounts", "connectStore", "controlledReportKeys", "buildApplyPackage", "ownerToken", "operationKey", "leaseTtlSeconds"];
  ok("C1 buildFbaPlanRelease: default AND explicit 0 -> the controls.apply call carries EXACTLY the pre-WP13 argument keys (no leaseWaitSeconds key -> one attempt, byte-identical)",
    JSON.stringify(Object.keys(d.calls[0])) === JSON.stringify(PRE_WP13_APPLY_KEYS) && JSON.stringify(Object.keys(z.calls[0])) === JSON.stringify(PRE_WP13_APPLY_KEYS));
  ok("C2 buildFbaPlanRelease({ leaseWaitSeconds: 600 }) -> ONLY the apply gains leaseWaitSeconds: 600 (the close never waits)",
    JSON.stringify(Object.keys(w.calls[0])) === JSON.stringify([...PRE_WP13_APPLY_KEYS, "leaseWaitSeconds"]) && w.calls[0].leaseWaitSeconds === 600);
  const throwsFor = (v) => { try { mk({ leaseWaitSeconds: v }); return false; } catch (e) { return /leaseWaitSeconds must be an integer/.test(String(e && e.message)); } };
  ok("C3 a malformed bound fails closed at BUILD time (-1, 1.5, '600', NaN, > MAX_CONTROL_LEASE_WAIT_SECONDS)",
    [-1, 1.5, "600", NaN, MAX_CONTROL_LEASE_WAIT_SECONDS + 1].every(throwsFor));
  // The two CLIs, statically: the ONLY change to each call is the conditional spread (absent / 0 -> no key at all).
  const pcp = readApp("scripts/release/priority-control-package.mjs");
  const OLD_PCP_CALL = 'result = await runControlPackageCli({ mode: MODE, operator: OPERATOR, discoverAccounts, connectStore, controlledReportKeys: CONTROLLED_REPORT_KEYS, ownerToken: EFFECTIVE_TOKEN, ownerGeneration: OWNER_GENERATION, operationKey: "priority-control/" + (BUCKET || "all") + "/" + ACCOUNT_SCOPE, log: (m) => console.log("  " + m) });';
  const SPREAD = ", ...(LEASE_WAIT_SECONDS > 0 ? { leaseWaitSeconds: LEASE_WAIT_SECONDS } : {}) });";
  const pcpCall = pcp.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("result = await runControlPackageCli("));
  ok("C4 priority-control-package.mjs: its one runControlPackageCli call is the pre-WP13 call + ONLY the conditional leaseWaitSeconds spread; --lease-wait-seconds is validated (integer <= MAX) and REFUSED with any mode but --apply, both BEFORE the store connection",
    pcpCall.length === 1 && pcpCall[0].endsWith(SPREAD) && pcpCall[0].slice(0, -SPREAD.length) + " });" === OLD_PCP_CALL
    && /if \(MODE !== "apply"\) \{ console\.error\("STOP --lease-wait-seconds is accepted ONLY with --apply/.test(pcp)
    && /if \(!\/\^\\d\{1,5\}\$\/\.test\(v\) \|\| Number\(v\) > MAX_CONTROL_LEASE_WAIT_SECONDS\)/.test(pcp)
    && pcp.indexOf("const rawLeaseWait") < pcp.indexOf("result = await runControlPackageCli("));
  const gl = readApp("scripts/release/fba-plan-golive.mjs");
  const glCalls = gl.split("\n").map((l) => l.trim()).filter((l) => /^release = buildFbaPlanRelease\(/.test(l));
  const OLD_GL_CALLS = [
    'release = buildFbaPlanRelease({ operator: OPERATOR, accountScopeIds: bootstrapScope.frozenAccountIds, ownerToken: runToken, controlOperationKey: "fba-plan/bootstrap/" + regionArg + "/" + dispatchId.slice(-8) });',
    'release = buildFbaPlanRelease({ operator: OPERATOR, ownerToken: runToken, controlOperationKey: "fba-plan/" + (scopeLabel || "all") });',
  ];
  ok("C5 fba-plan-golive.mjs: both buildFbaPlanRelease calls are the pre-WP13 calls + ONLY `...leaseWait` ({} when absent / 0); a malformed bound STOPs (exit 2) before any discovery / DataDoe call",
    glCalls.length === 2 && glCalls.every((c, i) => c.replace(", ...leaseWait });", " });") === OLD_GL_CALLS[i])
    && /const leaseWait = leaseWaitArg != null && Number\(leaseWaitArg\) > 0 \? \{ leaseWaitSeconds: Number\(leaseWaitArg\) \} : \{\};/.test(gl)
    && gl.indexOf("const leaseWaitArg") < gl.indexOf("release = buildFbaPlanRelease(") && gl.indexOf("const leaseWaitArg") < gl.indexOf("await release."));
}

/* ============================== D. the retired backfills are inert exit-2 stubs (never spawned) ============================== */
const RETIRED_BACKFILLS = {
  "scripts/release/backfill-brand-sales.mjs": { code: "BRAND_SALES_BACKFILL_RETIRED", names: "oli-publication-reconcile.mjs" },
  "scripts/release/backfill-daily-v2.mjs": { code: "DAILY_V2_BACKFILL_RETIRED", names: "oli-publication-reconcile.mjs" },
  "scripts/release/backfill-daily-named-brands.mjs": { code: "DAILY_NAMED_BRANDS_BACKFILL_RETIRED", names: "oli-publication-reconcile.mjs" },
  "scripts/release/backfill-sku-movement.mjs": { code: "SKU_MOVEMENT_BACKFILL_RETIRED", names: "publication-route-reconcile.mjs --route=sku-movement" },
};
for (const [file, exp] of Object.entries(RETIRED_BACKFILLS)) {
  const s = readApp(file); const code = stripComments(s);
  ok(`D1 ${file}: STATIC -- no import / require / dynamic import / env / fs / network in its code; one console.error + process.exit(2)`,
    !/\bimport\b|\brequire\s*\(|loadReleaseEnv|process\.env|readFileSync|fetch\s*\(|\bpg\b/.test(code) && count(code, "process.exit(") === 1 && /process\.exit\(2\);\s*$/.test(code.trim()) && count(code, "console.error(") === 1);
  // A vm Script has NO module loader: an import declaration is a SyntaxError and import() throws (no callback) -- so even a
  // reverted (real) backfill can never load .env.local or reach a database from here.
  const errors = []; let exitCode = null;
  const sandbox = vm.createContext({ console: { error: (...a) => errors.push(a.join(" ")), log: () => {} }, process: { exit: (c) => { exitCode = c; throw Object.assign(new Error("__exit__"), { __exit: true }); } } });
  let threw = null;
  try { new vm.Script(s, { filename: file }).runInContext(sandbox, { timeout: 2000 }); } catch (e) { threw = e; }
  ok(`D2 ${file}: SANDBOXED (vm, no loader / env / I/O) it exits 2 with its typed STOP ${exp.code} naming the fenced replacement (${exp.names})`,
    threw && threw.__exit === true && exitCode === 2 && errors.length === 1 && errors[0].startsWith("STOP " + exp.code + ":") && errors[0].includes(exp.names) && /Zero writes, zero DataDoe/.test(errors[0]));
}
{
  const { isForbiddenWorkerScript, FORBIDDEN_WORKER_SCRIPTS } = await import("../lib/server/recovery/registry.js");
  const retiredWriters = [...Object.keys(RETIRED_BACKFILLS), "scripts/release/report-materialization.mjs", "scripts/release/report-materialization-brandview.mjs"];
  ok("D3 every retired backfill + both retired materializer CLIs are FORBIDDEN to the worker (listed by name, and isForbiddenWorkerScript refuses each path)",
    retiredWriters.every((f) => isForbiddenWorkerScript(f) && FORBIDDEN_WORKER_SCRIPTS.includes(path.basename(f))));
}

/* ============================== E. the retired materializers write nothing ============================== */
for (const [cli, stop, extra] of [
  ["scripts/release/report-materialization.mjs", "STOP REPORT_MATERIALIZATION_LIVE_RETIRED", 'if (requestedMode === "live") {'],
  ["scripts/release/report-materialization-brandview.mjs", "STOP REPORT_MATERIALIZATION_BRANDVIEW_LIVE_RETIRED", 'if (requestedMode === "live" || argOf("inventory-as-of", null) != null) {'],
]) {
  const s = readApp(cli); const code = stripComments(s);
  const staticImports = [...code.matchAll(/^import\s[^\n]*from\s+"([^"]+)";/gm)].map((m) => m[1]);
  const iStop = code.indexOf(stop), iExit2 = code.indexOf("process.exit(2);", iStop), iEnv = code.indexOf("\nloadReleaseEnv();"), iDyn = code.indexOf("await import(");
  ok(`E1 ${cli}: --mode=live${/brandview/.test(cli) ? " (and the rebuild's --inventory-as-of)" : ""} is REFUSED (exit 2) BEFORE loadReleaseEnv() and before EVERY dynamic import (zero I/O); its only static import is env-bootstrap.mjs`,
    code.includes(extra) && iStop > 0 && iExit2 > iStop && iEnv > iExit2 && iDyn > iExit2 && code.indexOf(extra) < iStop
    && JSON.stringify(staticImports) === JSON.stringify(["./env-bootstrap.mjs"]) && count(code, "\nloadReleaseEnv();") === 1);
  ok(`E2 ${cli}: the remaining path is dry-run only (mode must be dry-run; dryRun = true; a reported write fails the run)`,
    /if \(mode !== "dry-run"\)/.test(code) && /const dryRun = true;/.test(code) && /if \(s\.materialized !== 0\)/.test(code) && !/runBrandInventoryRebuild/.test(code));
  // WP13 verifier P3-6: EVERY argument outside the dry-run allow-list ('--mode live', '--mode=LIVE', an unknown flag) is
  // refused BEFORE loadReleaseEnv too -- evaluated here against the file's OWN allow-list, extracted from its source.
  const allowSrc = (/const DRY_RUN_ARGS = (\[[^\n]*\]);/.exec(code) || [])[1];
  let allow = null; try { allow = allowSrc ? vm.runInNewContext(allowSrc) : null; } catch { allow = null; }
  const refused = (a) => !allow.some((re) => re.test(a));
  const iAllow = code.indexOf("const refusedArg = argv.find((a) => !DRY_RUN_ARGS.some((re) => re.test(a)));");
  ok(`E1b ${cli}: an argv allow-list refuses everything but --region=<r> / --mode=dry-run${/brandview/.test(cli) ? "" : " / --as-of=YYYY-MM-DD"} with exit 2 BEFORE loadReleaseEnv ('--mode live', '--mode=LIVE', '--live', 'live', '--apply', '--inventory-as-of=...' all refused; the dry-run spellings accepted)`,
    Array.isArray(allow) && iAllow > 0 && code.indexOf("process.exit(2);", iAllow) < iEnv && iAllow < iEnv
    && ["--mode", "live", "--mode=LIVE", "--mode=Live", "--live", "--apply", "--inventory-as-of=2026-09-27", "--region=india;rm", "--as-of=2026-9-1"].every(refused)
    && ["--region=india", "--region=europe-au", "--mode=dry-run"].every((a) => !refused(a))
    && (/brandview/.test(cli) ? refused("--as-of=2026-09-27") : !refused("--as-of=2026-09-27")));
}
{
  const bootstrap = stripComments(readApp("scripts/release/env-bootstrap.mjs"));
  ok("E3 env-bootstrap.mjs has NO import-time side effect (the retired CLIs' STOP runs before any env load)",
    !/^\s*(loadReleaseEnv|applyEnv)\(/m.test(bootstrap) && !/^\s*await\s/m.test(bootstrap));
  const W_SINKS = /\b(saveReportSnapshot|publishSnapshotUpdate|claimRefreshLock|releaseRefreshLock|publishLiveSnapshotIfNewer|casUpdateReportSnapshotByRev|insertReportSnapshotIfAbsent|deleteReportSnapshot\w*|pruneScheduledReportSnapshots)\b/;
  const { buildReportMaterializationRelease } = await import("../lib/server/sync/report-materialization-composition.js");
  const { buildBrandViewMaterializationRelease } = await import("../lib/server/sync/report-materialization-brandview-composition.js");
  const a = buildReportMaterializationRelease({ getConnections: () => [] });
  const b = buildBrandViewMaterializationRelease({ getConnections: () => [] });
  const WRITER_KEYS = ["persistSnapshot", "claimLock", "releaseLock"];
  ok("E4 both retired compositions bind NO writer / lock / publish (no persistSnapshot / claimLock / releaseLock) and import NO snapshot sink",
    WRITER_KEYS.every((k) => !(k in a) && !(k in b))
    && !W_SINKS.test(stripComments(readApp("lib/server/sync/report-materialization-composition.js")))
    && !W_SINKS.test(stripComments(readApp("lib/server/sync/report-materialization-brandview-composition.js"))));
  const { runReportMaterialization } = await import("../lib/server/sync/report-materialization-operation.js");
  const { runBrandViewMaterialization } = await import("../lib/server/sync/report-materialization-brandview-operation.js");
  const refuses = async (fn, args, rel) => { try { await fn(args, { ...rel, log: () => {} }); return false; } catch (e) { return /requires persistSnapshot for a live run/.test(String(e && e.message)); } };
  ok("E5 the operator cores REFUSE a live run over the retired compositions (no persistSnapshot -> fail closed before any unit)",
    await refuses(runReportMaterialization, { region: "india", accounts: [{ accountId: "A1", country: "IN" }], ceiling: "2026-09-27", dryRun: false }, a)
    && await refuses(runBrandViewMaterialization, { region: "india", accounts: [{ accountId: "A1", country: "IN" }], dryRun: false }, b));
  // Nothing outside the tests calls the brand-inventory rebuild any more (its core stays a DI-only function).
  const callers = [];
  const walk = (dir) => { for (const e of readdirSync(path.join(APP, dir), { withFileTypes: true })) { const rel = dir + "/" + e.name; if (e.isDirectory()) walk(rel); else if (/\.(m?js|jsx)$/.test(e.name) && /runBrandInventoryRebuild\s*\(/.test(stripComments(readApp(rel)))) callers.push(rel); } };
  for (const d of ["lib", "api", "scripts/release", "scripts/worker", "src"]) if (existsSync(path.join(APP, d))) walk(d);
  ok("E6 no production module calls runBrandInventoryRebuild (only its own definition)" + (callers.length > 1 ? " -- " + callers.join(", ") : ""),
    JSON.stringify(callers) === JSON.stringify(["lib/server/sync/report-materialization-brandview-operation.js"]));
}

/* ============================== H. LEASE FAIRNESS (WP13 verifier P2-1) ============================== */
{
  // The route CLI (live only) leaves the global lease free between its control windows for LONGER than a lease-waiter's
  // retry interval; the shared core's pause is opt-in (default 0) and is behaviour-tested in route-publication-release.
  const rel = await import("../lib/server/sync/route-publication-release.js");
  const cp = readApp("lib/server/sync/source-priority-control-package.js");
  const retrySec = Number((/leaseRetryIntervalSeconds = (\d+)/.exec(cp) || [])[1]);
  const cli = stripComments(readApp("scripts/release/publication-route-reconcile.mjs"));
  ok("H1 the route CLI passes interWindowPauseMs = ROUTE_CLI_INTER_WINDOW_PAUSE_MS for a LIVE run (0 for a dry-run, which holds no lease); the pause (" + rel.ROUTE_CLI_INTER_WINDOW_PAUSE_MS + " ms) is >= 2x runControlPackageCli's CONTROL_LEASE_HELD retry interval (" + retrySec + " s)",
    /interWindowPauseMs: dryRun \? 0 : rel\.ROUTE_CLI_INTER_WINDOW_PAUSE_MS,/.test(cli) && retrySec > 0 && rel.ROUTE_CLI_INTER_WINDOW_PAUSE_MS >= 2 * retrySec * 1000 && rel.ROUTE_CLI_INTER_WINDOW_PAUSE_MS <= 120000);
  for (const [f, code] of [["scripts/release/ads-publication-reconcile.mjs", "ADS_RECONCILE"], ["scripts/release/listing-health-v3-reconcile.mjs", "LISTINGS_RECONCILE"],
    ["scripts/release/oli-publication-reconcile.mjs", "OLI_RECONCILE"], ["scripts/release/fba-publication-reconcile.mjs", "FBA_RECONCILE"]]) {
    const s = stripComments(readApp(f));
    const applyCalls = s.split("runControlPackageCli({").slice(1).map((c) => c.slice(0, c.indexOf("});")));
    const applyCall = applyCalls.filter((c) => /mode: "apply"/.test(c));
    // Immediate mode RENEWS the scheduler's fence and returns BEFORE the apply, so it can never wait (round-2 P3-B).
    const iImm = s.indexOf('if (mode === "immediate") {'), iApply = s.indexOf('mode: "apply"');
    const immBlock = iImm >= 0 && iApply > iImm ? s.slice(iImm, iApply) : "";
    ok(`H2 ${f}: an OPTIONAL --lease-wait-seconds (integer 0..900; malformed -> STOP ${code}_LEASE_WAIT exit 2) reaches ONLY its periodic controls APPLY as a conditional spread, CAPPED (Math.min) at the run's start cutoff (absent / 0 -> no leaseWaitSeconds key: byte-identical); immediate mode renews and returns before the apply (never waits)`,
      applyCall.length === 1 && /\.\.\.applyLeaseWait\(\),\s*$/.test(applyCall[0]) && !applyCalls.filter((c) => !/mode: "apply"/.test(c)).some((c) => /applyLeaseWait|leaseWaitSeconds/.test(c))
      && s.includes("if (rawLeaseWait != null && (!/^\\d{1,3}$/.test(rawLeaseWait) || Number(rawLeaseWait) > 900)) { console.error(\"STOP " + code + "_LEASE_WAIT:")
      && /if \(!\(LEASE_WAIT_SECONDS > 0\)\) return \{\};/.test(s) && /const cap = deadlineSec > 0 \? Math\.max\(0, Math\.floor\(startCutoffSec - \(Date\.now\(\) - runStartMs\) \/ 1000\)\) : LEASE_WAIT_SECONDS;/.test(s)
      && /const n = Math\.min\(LEASE_WAIT_SECONDS, cap\);/.test(s) && /return n > 0 \? \{ leaseWaitSeconds: n \} : \{\};/.test(s)
      && /renewControlPlaneLease/.test(immBlock) && /return \{ ok: true \};/.test(immBlock) && !/applyLeaseWait/.test(immBlock));
  }
  const ads = job("ads_reconcile"), rec = job("listing_health_v3_reconcile"), fbaJob = job("fba");
  ok("H3 the scheduler's immediate Ads + LHv3 reconcilers and the fba job's immediate FBA reconcile pass --lease-wait-seconds=600 (the route-CLI materialize jobs hold the lease in windows); ads_reconcile keeps needs [run, fba]",
    /ads-publication-reconcile\.mjs [^\n]*--deadline-seconds=300 --lease-wait-seconds=600 \$LIVE\n/.test(ads) && /listing-health-v3-reconcile\.mjs [^\n]*--deadline-seconds=720 --lease-wait-seconds=600 \$LIVE\n/.test(rec)
    // D3: the fba job's reconcile deadline is 900 s (covers europe-au's 32 accounts; the start cutoff is 780 s).
    && /fba-publication-reconcile\.mjs [^\n]*--mode=periodic --deadline-seconds=900 --lease-wait-seconds=600 \$LIVE\n/.test(fbaJob)
    && /\n\s{4}needs: \[run, fba\]\n/.test(ads));
  const BACKSTOPS = [
    ["oli-publication-reconcile.yml", /oli-publication-reconcile\.mjs [^\n]*--deadline-seconds=330 --lease-wait-seconds=600 \$LIVE \$DRAIN/],
    ["oli-outbox-drain.yml", /oli-publication-reconcile\.mjs [^\n]*--deadline-seconds=330 --lease-wait-seconds=600 --outbox-drain \$LIVE/],
    ["fba-publication-reconcile.yml", /fba-publication-reconcile\.mjs [^\n]*--deadline-seconds=330 --lease-wait-seconds=600 \$LIVE/],
    ["ads-publication-reconcile.yml", /ads-publication-reconcile\.mjs [^\n]*--deadline-seconds=330 --lease-wait-seconds=600 \$LIVE/],
    ["listing-health-v3-reconcile.yml", /listing-health-v3-reconcile\.mjs [^\n]*--deadline-seconds=720 --lease-wait-seconds=600 \$LIVE/],
  ];
  ok("H4 (round-2 P2-A) every zero-export backstop / drain workflow passes --lease-wait-seconds=600 to its live reconcile (capped by the CLI at its start cutoff), and NEVER to its --cleanup call",
    BACKSTOPS.every(([f, re]) => { const t = readRepo(".github/workflows/" + f); return re.test(t) && t.split("\n").filter((l) => /--cleanup/.test(l) && !/^\s*#/.test(l)).every((l) => !/lease-wait/.test(l)); }));
}

/* ============================== F. the scheduler-v1 LIBRARY refuses every route-owned key itself ============================== */
const { FENCED_WRITER_REPORT_KEYS } = await import("../lib/server/sync/report-writer-fence.js");
const { ROUTE_OWNED_LIVE_REPORT_KEYS, isRouteOwnedLiveReportKey, ROUTE_OWNED_REPORT_V1_REFUSED } = await import("../lib/server/report-store.js");
{
  const { runReportAdapter, isSchedulerV1WritableReportKey, assertSchedulerV1ReportKeys } = await import("../lib/server/sync/adapters/report-adapter.js");
  const { runScheduledSync } = await import("../lib/server/sync/run-sync.js");
  const MANUAL = ["sku-pl", "sales", "reconciliation", "keyword-rank", "ppc-performance", "listing-health"];
  const f0 = fetchCalls;
  for (const key of FENCED_WRITER_REPORT_KEYS) {
    const calls = [];
    let adapterErr = null;
    try {
      await runReportAdapter({
        entry: { reportKey: key, reportVersion: key + "-v", windowFor: () => ({ from: "2026-01-01", to: "2026-09-27" }), validate: () => true },
        account: { account_id: "123", country: "US" }, asOf: "2026-09-27", connections: [{ id: "primary", apiKey: "x" }],
        build: async () => { calls.push("build"); return { rows: [] }; }, save: async () => { calls.push("save"); return { id: "s" }; },
        prune: async () => { calls.push("prune"); }, publish: async () => { calls.push("publish"); },
      });
    } catch (e) { adapterErr = e; }
    const typed = (e) => !!e && e.code === ROUTE_OWNED_REPORT_V1_REFUSED && e.status === 409 && Array.isArray(e.refusedReportKeys) && e.refusedReportKeys.includes(key);
    let syncErr = null, mixedErr = null;
    try { await runScheduledSync({ bucket: "us", reportKeys: [key] }); } catch (e) { syncErr = e; }
    try { await runScheduledSync({ bucket: "non-us", reportKeys: ["sku-pl", key] }); } catch (e) { mixedErr = e; }
    ok(`F1 ${key}: the v1 adapter refuses it typed (409) with ZERO build / save / prune / publish; runScheduledSync refuses it (alone AND in a mixed list) before any read`,
      typed(adapterErr) && calls.length === 0 && typed(syncErr) && typed(mixedErr) && !isSchedulerV1WritableReportKey(key));
  }
  ok("F2 ... and not one of those refusals reached the network (zero fetch)", fetchCalls === f0);
  {
    const calls = [];
    const r = await runReportAdapter({
      entry: { reportKey: "sku-pl", reportVersion: "sku-pl-shared-v1", windowFor: () => ({ from: "2026-01-01", to: "2026-09-27" }), validate: () => true },
      account: { account_id: "123", country: "US" }, asOf: "2026-09-27", connections: [{ id: "primary", apiKey: "x" }],
      build: async () => { calls.push("build"); return { rows: [{ date: "2026-09-26" }] }; }, save: async () => { calls.push("save"); return { id: "s" }; },
      prune: async () => { calls.push("prune"); }, publish: async () => { calls.push("publish"); },
    }).catch((e) => ({ err: e }));
    ok("F3 a MANUAL-PAID v1 key still runs through the adapter unchanged (build -> save -> prune -> publish); v1-writable = not route-owned",
      r && !r.err && JSON.stringify(calls) === JSON.stringify(["build", "save", "prune", "publish"]) && MANUAL.every((k) => isSchedulerV1WritableReportKey(k))
      && !isSchedulerV1WritableReportKey("") && !isSchedulerV1WritableReportKey(null) && !isSchedulerV1WritableReportKey(undefined));
  }
  let assertErr = null; try { assertSchedulerV1ReportKeys(["sales", "sku-movement", "brand-view"], "t"); } catch (e) { assertErr = e; }
  ok("F4 assertSchedulerV1ReportKeys names EVERY refused key of a mixed list, sorted (no partial run)",
    assertErr && JSON.stringify(assertErr.refusedReportKeys) === JSON.stringify(["brand-view", "sku-movement"]));
  const rs = stripComments(readApp("lib/server/sync/run-sync.js"));
  ok("F5 run-sync.js: runRetention skips route-owned keys; the schedule-enabled work list EXCLUDES them (typed skipped 'route-owned-refused'); the explicit-list refusal precedes every read",
    /if \(!isSchedulerV1WritableReportKey\(entry\.reportKey\)\) continue;/.test(rs)
    && /const selectedEntries = bucketSelected\.filter\(\(entry\) => isSchedulerV1WritableReportKey\(entry\.reportKey\)\);/.test(rs) && /skipped: "route-owned-refused"/.test(rs)
    && rs.indexOf("if (reportKeys) assertSchedulerV1ReportKeys(") < rs.indexOf("await getReportSyncSettings()"));
}

/* ============================== G. one route-owned key set everywhere ============================== */
{
  const mig = readApp("supabase/migrations/20260935_report_publication_writer_fence.sql");
  const seedBlock = (/insert into public\.report_publication_writer_fence \(report_key, fenced_only, updated_by\) values([\s\S]*?)on conflict/.exec(mig) || [])[1] || "";
  const seed = [...seedBlock.matchAll(/\('([a-z0-9-]+)', false, 'migration:20260935'\)/g)].map((m) => m[1]);
  const sorted = (a) => JSON.stringify([...a].sort());
  ok("G1 the writer-fence keys == report-store's route-owned set == the 20260935 migration seed (10 keys, all fenced_only=false at apply)",
    FENCED_WRITER_REPORT_KEYS.length === 10 && sorted(FENCED_WRITER_REPORT_KEYS) === sorted(ROUTE_OWNED_LIVE_REPORT_KEYS) && sorted(FENCED_WRITER_REPORT_KEYS) === sorted(seed)
    && FENCED_WRITER_REPORT_KEYS.every((k) => isRouteOwnedLiveReportKey(k)));
  ok("G2 every publisher key the scheduler route jobs publish is route-owned (fenced)", MAT.flatMap((m) => m.publisherKeys).every((k) => FENCED_WRITER_REPORT_KEYS.includes(k)));
}

ok("Z the whole suite made ZERO network calls", fetchCalls === 0);
writeSync(1, `\nscheduler-v2-route-switch: ${passed} assertions passed\n`);
