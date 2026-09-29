// Scheduler report materialization -- RETIRED AS A WRITER (publication recovery WP13); now READ-ONLY DRY-RUN tooling.
//
// It used to be the scheduler-v2 `materialize` job's UNFENCED writer of brand-view-brands, sku-movement (per brand incl.
// ALL) and returns-leakage (v3) -- a direct saveReportSnapshot outside the four-gate publisher / fenced CAS /
// sync_report_jobs lineage. Those three keys are now published ONLY through the FENCED zero-export route CLI, which the
// scheduler-v2 `materialize` job runs unconditionally:
//
//   node scripts/release/publication-route-reconcile.mjs --route=brand-view-brands,sku-movement,returns-v3 \
//     --bucket=<india|europe-au|us-ca> --as-of=YYYY-MM-DD   (dry-run by default; --mode=scheduler --live --run-token=<t>)
//
// What remains here is a READ-ONLY plan: the same zero-export derivations over durable evidence, each unit reported
// 'planned' (or 'unavailable'), and NOTHING is written -- the composition (report-materialization-composition.js) binds
// no snapshot writer, lock or publish at all, and the operator core refuses a live run without one.
//
//   Dry-run (the only mode; writes NOTHING):
//     node scripts/release/report-materialization.mjs --region=india [--as-of=YYYY-MM-DD]
//
// --mode=live is REFUSED (exit 2) BEFORE any env load, import, discovery or connection -- so a stale / reverted caller
// fails closed with zero I/O (and once the WP15 writer fence is ON for these keys a reverted legacy writer would fail
// closed at the database too). Flags: --region=india|europe-au|us-ca (required), --mode=dry-run (default; 'live' is
// refused), --as-of=YYYY-MM-DD (UTC future-guard ceiling; default UTC today -- the derive clamps down to each account's
// latest proven date). ZERO DataDoe exports (no adapter on this path). 7-bit ASCII, LF.

import { loadReleaseEnv } from "./env-bootstrap.mjs";

const argv = process.argv.slice(2);
const argOf = (name, dflt = null) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf("=");
  return eq === -1 ? true : hit.slice(eq + 1);
};
const log = (m) => process.stdout.write(`${m}\n`);

// FIRST (before loadReleaseEnv and every dynamic import): the retired write mode is refused with zero I/O.
const requestedMode = String(argOf("mode", "dry-run") || "dry-run").trim();
if (requestedMode === "live") {
  console.error("STOP REPORT_MATERIALIZATION_LIVE_RETIRED: scripts/release/report-materialization.mjs --mode=live is retired (an unfenced writer of brand-view-brands, sku-movement and returns-leakage). "
    + "Publish them ONLY through the fenced zero-export route CLI: node scripts/release/publication-route-reconcile.mjs --route=brand-view-brands,sku-movement,returns-v3 --bucket=<india|europe-au|us-ca> --as-of=YYYY-MM-DD "
    + "(dry-run by default; the scheduler runs it with --mode=scheduler --live --run-token=<token>). Zero writes, zero DataDoe.");
  process.exit(2);
}
// ... and EVERY other argument outside the dry-run allow-list is refused BEFORE any env load too (WP13 verifier P3-6: a
// '--mode live' / '--mode=LIVE' spelling or an unknown flag must never reach loadReleaseEnv): ONLY --region=<r>,
// --mode=dry-run and --as-of=YYYY-MM-DD are accepted.
const DRY_RUN_ARGS = [/^--region=[a-z-]{1,20}$/, /^--mode=dry-run$/, /^--as-of=\d{4}-\d{2}-\d{2}$/];
const refusedArg = argv.find((a) => !DRY_RUN_ARGS.some((re) => re.test(a)));
if (refusedArg !== undefined) {
  console.error("STOP REPORT_MATERIALIZATION_ARG_REFUSED: scripts/release/report-materialization.mjs is retired read-only dry-run tooling; the only accepted arguments are --region=<india|europe-au|us-ca> --mode=dry-run [--as-of=YYYY-MM-DD] (refused: "
    + String(refusedArg).replace(/[^\x20-\x7e]/g, "").slice(0, 40) + "). Zero writes, zero DataDoe, zero I/O.");
  process.exit(2);
}

loadReleaseEnv();

// DYNAMIC imports AFTER loadReleaseEnv(): lib/server/supabase.js reads SUPABASE_URL + the service key at MODULE-EVAL
// time, and static ESM imports are hoisted ABOVE the loadReleaseEnv() call above. On a GitHub Actions runner the env
// is already in process.env before node starts (so static would be fine), but for a LOCAL run env comes from
// <repo>/.env.local via loadReleaseEnv() -- which must run FIRST. Dynamic import guarantees that ordering everywhere.
const { buildReportMaterializationRelease } = await import("../../lib/server/sync/report-materialization-composition.js");
const { runReportMaterialization } = await import("../../lib/server/sync/report-materialization-operation.js");
const { REGION_SCOPES } = await import("../../lib/server/sync/scheduler-scope.js");

async function main() {
  const region = String(argOf("region", "") || "").trim();
  const mode = requestedMode;
  const asOf = argOf("as-of", null);

  if (!REGION_SCOPES.includes(region)) {
    log(`report-materialization: --region must be one of ${REGION_SCOPES.join(", ")} (got "${region}"). Refusing.`);
    process.exit(2);
  }
  if (mode !== "dry-run") {
    log(`report-materialization: --mode must be dry-run (got "${mode}"; the live write mode is retired). Refusing.`);
    process.exit(2);
  }
  if (asOf != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(asOf))) {
    log(`report-materialization: --as-of must be YYYY-MM-DD (got "${asOf}"). Refusing.`);
    process.exit(2);
  }
  const dryRun = true;
  const ceiling = asOf ? String(asOf) : new Date().toISOString().slice(0, 10);

  const release = buildReportMaterializationRelease({ operator: process.env.PRIORITY_OPERATOR || "laxmikant@superboring.in" });
  if (!release.hasPrimary) {
    log("report-materialization: no usable primary DataDoe connection configured. Refusing.");
    process.exit(1);
  }

  const accounts = await release.discoverAccounts(region);
  log(`report-materialization[${region}] DRY-RUN (read-only; the live write mode is retired) as-of ${ceiling}: ${accounts.length} primary account(s).`);
  if (!accounts.length) {
    log("report-materialization: no primary accounts in this region. Nothing to plan.");
    process.exit(0);
  }

  const result = await runReportMaterialization({ region, accounts, ceiling, dryRun }, { ...release, log });
  const s = result.summary;

  // Per-report tally (planned / unavailable / error) -- a read-only plan.
  const byReport = new Map();
  for (const e of result.events) {
    if (!e.report || e.report === "*") continue;
    const r = byReport.get(e.report) || { materialized: 0, unchanged: 0, unavailable: 0, planned: 0, error: 0, locked: 0 };
    if (e.status === "materialized") r.materialized += 1;
    else if (e.status === "unchanged") r.unchanged += 1;
    else if (e.status === "unavailable") r.unavailable += 1;
    else if (e.status === "planned") r.planned += 1;
    else if (e.status === "error") r.error += 1;
    else if (e.status === "locked-skip") r.locked += 1;
    byReport.set(e.report, r);
  }
  for (const [report, r] of byReport) {
    log(`  ${report}: planned ${r.planned}, unavailable ${r.unavailable}, error ${r.error}`);
  }
  log(`report-materialization[${region}] DRY-RUN DONE: accounts ${s.accounts}, units ${s.units}, planned ${s.planned}, `
    + `unavailable ${s.unavailable}, error ${s.error}, materialized ${s.materialized} (must be 0), tokens ${s.tokens} (must be 0).`);

  if (s.tokens !== 0) { log("report-materialization: NON-ZERO token count -- this path must never spend a token. Failing."); process.exit(1); }
  if (s.materialized !== 0) { log("report-materialization: a dry-run reported a write -- impossible by construction. Failing."); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { log(`report-materialization: FATAL ${e && e.stack ? e.stack : e}`); process.exit(1); });
