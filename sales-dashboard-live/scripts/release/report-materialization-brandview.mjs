// FBA-aware Brand View materializer -- RETIRED AS A WRITER (publication recovery WP13); now READ-ONLY DRY-RUN tooling.
//
// It used to be the scheduler-v2 `materialize-inventory` job's UNFENCED writer of brand-view + brand-view-portfolio AND
// of the compact brand-inventory REBUILD (a direct saveReportSnapshot outside the four-gate publisher / fenced CAS /
// sync_report_jobs lineage). brand-view + brand-view-portfolio are now published ONLY through the FENCED zero-export
// route CLI, which the scheduler-v2 `materialize-inventory` job runs unconditionally:
//
//   node scripts/release/publication-route-reconcile.mjs --route=brand-view,brand-view-portfolio \
//     --bucket=<india|europe-au|us-ca> --as-of=YYYY-MM-DD   (dry-run by default; --mode=scheduler --live --run-token=<t>)
//
// and brand-inventory ONLY by the fenced OLI / FBA reconcilers + the priority publication. The brand-inventory rebuild is
// REMOVED from this tool entirely (not even planned). What remains is a READ-ONLY plan of the Brand View derivations over
// durable evidence (each unit 'planned' / 'unavailable'); NOTHING is written -- the composition
// (report-materialization-brandview-composition.js) binds no snapshot writer, lock or publish at all.
//
//   Dry-run (the only mode; writes NOTHING):  node scripts/release/report-materialization-brandview.mjs --region=india
//
// --mode=live and the rebuild's --inventory-as-of are REFUSED (exit 2) BEFORE any env load, import, discovery or
// connection -- a stale / reverted caller fails closed with zero I/O (and once the WP15 writer fence is ON for these keys
// a reverted legacy writer would fail closed at the database too). Flags: --region=india|europe-au|us-ca (required),
// --mode=dry-run (default). asOf is derived per the serve (single: marketplaceToday(account.country); portfolio:
// marketplaceToday("IN")). ZERO DataDoe exports (no adapter on this path). 7-bit ASCII, LF.

import { loadReleaseEnv } from "./env-bootstrap.mjs";

const argv = process.argv.slice(2);
const argOf = (name, dflt = null) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf("=");
  return eq === -1 ? true : hit.slice(eq + 1);
};
const log = (m) => process.stdout.write(`${m}\n`);

// FIRST (before loadReleaseEnv and every dynamic import): the retired write mode + the retired rebuild's flag are refused
// with zero I/O.
const requestedMode = String(argOf("mode", "dry-run") || "dry-run").trim();
if (requestedMode === "live" || argOf("inventory-as-of", null) != null) {
  console.error("STOP REPORT_MATERIALIZATION_BRANDVIEW_LIVE_RETIRED: scripts/release/report-materialization-brandview.mjs --mode=live (and the brand-inventory rebuild's --inventory-as-of) is retired (an unfenced writer of brand-view, brand-view-portfolio and brand-inventory). "
    + "Publish Brand View ONLY through the fenced zero-export route CLI: node scripts/release/publication-route-reconcile.mjs --route=brand-view,brand-view-portfolio --bucket=<india|europe-au|us-ca> --as-of=YYYY-MM-DD "
    + "(dry-run by default; the scheduler runs it with --mode=scheduler --live --run-token=<token>); brand-inventory is published only by the fenced OLI / FBA reconcilers. Zero writes, zero DataDoe.");
  process.exit(2);
}
// ... and EVERY other argument outside the dry-run allow-list is refused BEFORE any env load too (WP13 verifier P3-6: a
// '--mode live' / '--mode=LIVE' spelling or an unknown flag must never reach loadReleaseEnv): ONLY --region=<r> and
// --mode=dry-run are accepted.
const DRY_RUN_ARGS = [/^--region=[a-z-]{1,20}$/, /^--mode=dry-run$/];
const refusedArg = argv.find((a) => !DRY_RUN_ARGS.some((re) => re.test(a)));
if (refusedArg !== undefined) {
  console.error("STOP REPORT_MATERIALIZATION_BRANDVIEW_ARG_REFUSED: scripts/release/report-materialization-brandview.mjs is retired read-only dry-run tooling; the only accepted arguments are --region=<india|europe-au|us-ca> --mode=dry-run (refused: "
    + String(refusedArg).replace(/[^\x20-\x7e]/g, "").slice(0, 40) + "). Zero writes, zero DataDoe, zero I/O.");
  process.exit(2);
}

loadReleaseEnv();

// DYNAMIC imports AFTER loadReleaseEnv() -- lib/server/supabase.js reads env at module-eval and static ESM imports hoist
// above the call above (CI already has env, but a local run needs .env.local loaded first). See report-materialization.mjs.
const { buildBrandViewMaterializationRelease } = await import("../../lib/server/sync/report-materialization-brandview-composition.js");
const { runBrandViewMaterialization } = await import("../../lib/server/sync/report-materialization-brandview-operation.js");
const { REGION_SCOPES } = await import("../../lib/server/sync/scheduler-scope.js");

async function main() {
  const region = String(argOf("region", "") || "").trim();
  const mode = requestedMode;
  if (!REGION_SCOPES.includes(region)) { log(`report-materialization-brandview: --region must be one of ${REGION_SCOPES.join(", ")} (got "${region}"). Refusing.`); process.exit(2); }
  if (mode !== "dry-run") { log(`report-materialization-brandview: --mode must be dry-run (got "${mode}"; the live write mode is retired). Refusing.`); process.exit(2); }
  const dryRun = true;

  const release = buildBrandViewMaterializationRelease({ operator: process.env.PRIORITY_OPERATOR || "laxmikant@superboring.in" });
  if (!release.hasPrimary) { log("report-materialization-brandview: no usable primary DataDoe connection configured. Refusing."); process.exit(1); }

  const accounts = await release.discoverAccounts(region);
  log(`report-materialization-brandview[${region}] DRY-RUN (read-only; the live write mode + the brand-inventory rebuild are retired): ${accounts.length} primary account(s).`);
  if (!accounts.length) { log("report-materialization-brandview: no primary accounts in this region. Nothing to plan."); process.exit(0); }

  const result = await runBrandViewMaterialization({ region, accounts, dryRun }, { ...release, log });
  const s = result.summary;

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
  log(`report-materialization-brandview[${region}] DRY-RUN DONE: identities ${s.accounts}, units ${s.units}, planned ${s.planned}, `
    + `unavailable ${s.unavailable}, error ${s.error}, materialized ${s.materialized} (must be 0), tokens ${s.tokens} (must be 0).`);

  if (s.tokens !== 0) { log("report-materialization-brandview: NON-ZERO token count -- this path must never spend a token. Failing."); process.exit(1); }
  if (s.materialized !== 0) { log("report-materialization-brandview: a dry-run reported a write -- impossible by construction. Failing."); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { log(`report-materialization-brandview: FATAL ${e && e.stack ? e.stack : e}`); process.exit(1); });
