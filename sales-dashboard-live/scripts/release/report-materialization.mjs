// Scheduler-owned report materialization runner (Phase 3, Increment 1).
//
// Runs the ZERO-EXPORT report materialization operator for ONE region: it derives the owned durable reports
// (brand-view-brands, sku-movement per brand incl. ALL, returns-leakage) for that region's primary accounts from
// already-durable evidence and upserts each snapshot under the exact identity the serve reads -- so a normal page
// visit afterwards finds a ready snapshot and never writes one. There is NO DataDoe adapter on this path: it can
// never create an export or spend a token, in dry-run OR live.
//
//   Dry-run (default, writes NOTHING):
//     node scripts/release/report-materialization.mjs --region=india
//   Live (upserts snapshots; still zero DataDoe):
//     node scripts/release/report-materialization.mjs --region=india --mode=live
//
// Flags: --region=india|europe-au|us-ca (required), --mode=dry-run|live (default dry-run), --as-of=YYYY-MM-DD
// (UTC future-guard ceiling; default UTC today -- the derive clamps down to each account's latest proven date).

import { loadReleaseEnv } from "./env-bootstrap.mjs";
loadReleaseEnv();

// DYNAMIC imports AFTER loadReleaseEnv(): lib/server/supabase.js reads SUPABASE_URL + the service key at MODULE-EVAL
// time, and static ESM imports are hoisted ABOVE the loadReleaseEnv() call above. On a GitHub Actions runner the env
// is already in process.env before node starts (so static would be fine), but for a LOCAL run env comes from
// <repo>/.env.local via loadReleaseEnv() -- which must run FIRST. Dynamic import guarantees that ordering everywhere.
const { buildReportMaterializationRelease } = await import("../../lib/server/sync/report-materialization-composition.js");
const { runReportMaterialization } = await import("../../lib/server/sync/report-materialization-operation.js");
const { REGION_SCOPES } = await import("../../lib/server/sync/scheduler-scope.js");

const argv = process.argv.slice(2);
const argOf = (name, dflt = null) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf("=");
  return eq === -1 ? true : hit.slice(eq + 1);
};

const log = (m) => process.stdout.write(`${m}\n`);

async function main() {
  const region = String(argOf("region", "") || "").trim();
  const mode = String(argOf("mode", "dry-run") || "dry-run").trim();
  const asOf = argOf("as-of", null);

  if (!REGION_SCOPES.includes(region)) {
    log(`report-materialization: --region must be one of ${REGION_SCOPES.join(", ")} (got "${region}"). Refusing.`);
    process.exit(2);
  }
  if (mode !== "dry-run" && mode !== "live") {
    log(`report-materialization: --mode must be dry-run|live (got "${mode}"). Refusing.`);
    process.exit(2);
  }
  if (asOf != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(asOf))) {
    log(`report-materialization: --as-of must be YYYY-MM-DD (got "${asOf}"). Refusing.`);
    process.exit(2);
  }
  const dryRun = mode !== "live";
  const ceiling = asOf ? String(asOf) : new Date().toISOString().slice(0, 10);

  const release = buildReportMaterializationRelease({ operator: process.env.PRIORITY_OPERATOR || "laxmikant@superboring.in" });
  if (!release.hasPrimary) {
    log("report-materialization: no usable primary DataDoe connection configured. Refusing.");
    process.exit(1);
  }

  const accounts = await release.discoverAccounts(region);
  log(`report-materialization[${region}] ${dryRun ? "DRY-RUN" : "LIVE"} as-of ${ceiling}: ${accounts.length} primary account(s).`);
  if (!accounts.length) {
    log("report-materialization: no primary accounts in this region. Nothing to materialize.");
    process.exit(0);
  }

  const result = await runReportMaterialization({ region, accounts, ceiling, dryRun }, { ...release, log });
  const s = result.summary;

  // Per-report tally (materialized / unchanged / unavailable / error), most useful for the natural-run readback.
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
    log(`  ${report}: materialized ${r.materialized}, unchanged ${r.unchanged}, unavailable ${r.unavailable}, planned ${r.planned}, error ${r.error}, locked ${r.locked}`);
  }
  log(`report-materialization[${region}] DONE: accounts ${s.accounts}, units ${s.units}, materialized ${s.materialized}, `
    + `unchanged ${s.unchanged}, unavailable ${s.unavailable}, planned ${s.planned}, error ${s.error}, tokens ${s.tokens} (must be 0).`);

  if (s.tokens !== 0) { log("report-materialization: NON-ZERO token count -- this path must never spend a token. Failing."); process.exit(1); }
  // A live run with only errors (and nothing materialized/unchanged) is a hard failure; unavailable is honest (LKG kept).
  if (!dryRun && s.error > 0 && s.materialized === 0 && s.unchanged === 0) { process.exit(1); }
  process.exit(0);
}

main().catch((e) => { log(`report-materialization: FATAL ${e && e.stack ? e.stack : e}`); process.exit(1); });
