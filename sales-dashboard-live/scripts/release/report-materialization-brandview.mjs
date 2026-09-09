// FBA-aware Brand View materializer runner (Phase 3 Completion).
//
// Publishes the scheduler-owned snapshots for brand-view (single account+brand) and brand-view-portfolio (a brand
// across a region's accounts) so those pages CONVERGE with no user Refresh -- the missing backend producer. ZERO
// DataDoe: no adapter is on this path (in dry-run OR live); the runner fails if it ever observes a non-zero token.
//
//   Dry-run (default, writes NOTHING):  node scripts/release/report-materialization-brandview.mjs --region=india
//   Live (upserts snapshots):           node scripts/release/report-materialization-brandview.mjs --region=india --mode=live
//
// Flags: --region=india|europe-au|us-ca (required), --mode=dry-run|live (default dry-run). asOf is derived per the serve
// (single: marketplaceToday(account.country); portfolio: marketplaceToday("IN")) -- there is no --as-of override.

import { loadReleaseEnv } from "./env-bootstrap.mjs";
loadReleaseEnv();

// DYNAMIC imports AFTER loadReleaseEnv() -- lib/server/supabase.js reads env at module-eval and static ESM imports hoist
// above the call above (CI already has env, but a local run needs .env.local loaded first). See report-materialization.mjs.
const { buildBrandViewMaterializationRelease } = await import("../../lib/server/sync/report-materialization-brandview-composition.js");
const { runBrandViewMaterialization, runBrandInventoryRebuild } = await import("../../lib/server/sync/report-materialization-brandview-operation.js");
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
  // The shared cycle D-1 (needs.run.outputs.inventory_asof). The compact brand-inventory rebuild binds its
  // PER-ACCOUNT authorization to it (a live compact only authorizes a refresh when it was published for THIS cycle
  // -- live.params.to === inventoryAsOf). Absent -> the rebuild authorizes NOTHING (fail closed).
  const inventoryAsOf = String(argOf("inventory-as-of", "") || "").trim() || null;
  if (!REGION_SCOPES.includes(region)) { log(`report-materialization-brandview: --region must be one of ${REGION_SCOPES.join(", ")} (got "${region}"). Refusing.`); process.exit(2); }
  if (mode !== "dry-run" && mode !== "live") { log(`report-materialization-brandview: --mode must be dry-run|live (got "${mode}"). Refusing.`); process.exit(2); }
  if (inventoryAsOf && !/^\d{4}-\d{2}-\d{2}$/.test(inventoryAsOf)) { log(`report-materialization-brandview: --inventory-as-of must be YYYY-MM-DD (got "${inventoryAsOf}"). Refusing.`); process.exit(2); }
  const dryRun = mode !== "live";

  const release = buildBrandViewMaterializationRelease({ operator: process.env.PRIORITY_OPERATOR || "laxmikant@superboring.in" });
  if (!release.hasPrimary) { log("report-materialization-brandview: no usable primary DataDoe connection configured. Refusing."); process.exit(1); }

  const accounts = await release.discoverAccounts(region);
  log(`report-materialization-brandview[${region}] ${dryRun ? "DRY-RUN" : "LIVE"}: ${accounts.length} primary account(s).`);
  if (!accounts.length) { log("report-materialization-brandview: no primary accounts in this region. Nothing to materialize."); process.exit(0); }

  // Defect A: FIRST rebuild the compact brand-inventory from each account's FRESH fba-plan snapshot (this job runs
  // AFTER the fba job), so Brand View's exclusive-compact consumer reads CURRENT inventory below. Gated on the
  // source-promoted publish control; zero-export. A tokens>0 here is impossible (no adapter) but re-checked below.
  const invResult = await runBrandInventoryRebuild({ region, accounts, inventoryAsOf, dryRun }, { ...release, log });
  if (invResult && invResult.summary && invResult.summary.tokens !== 0) {
    log("report-materialization-brandview: NON-ZERO token count in brand-inventory rebuild -- this path must never spend a token. Failing.");
    process.exit(1);
  }

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
    log(`  ${report}: materialized ${r.materialized}, unchanged ${r.unchanged}, unavailable ${r.unavailable}, planned ${r.planned}, error ${r.error}, locked ${r.locked}`);
  }
  log(`report-materialization-brandview[${region}] DONE: identities ${s.accounts}, units ${s.units}, materialized ${s.materialized}, `
    + `unchanged ${s.unchanged}, unavailable ${s.unavailable}, planned ${s.planned}, error ${s.error}, tokens ${s.tokens} (must be 0).`);

  if (s.tokens !== 0) { log("report-materialization-brandview: NON-ZERO token count -- this path must never spend a token. Failing."); process.exit(1); }
  if (!dryRun && s.error > 0 && s.materialized === 0 && s.unchanged === 0) { process.exit(1); }
  process.exit(0);
}

main().catch((e) => { log(`report-materialization-brandview: FATAL ${e && e.stack ? e.stack : e}`); process.exit(1); });
