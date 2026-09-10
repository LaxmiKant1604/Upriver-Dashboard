// Direct Node verification runner.
//
// `npm run verify` used to be a nested-npm chain ("npm run a && npm run b && ...").
// On some npm/cmd setups (observed here: npm 11.11.0 with the cmd.exe script shell,
// from both Git Bash and PowerShell) that chain echoes the command line and exits 0
// WITHOUT executing any child -- a silent no-op that would happily "pass" a broken
// tree. This runner replaces it: every suite's test files plus build-check run
// SEQUENTIALLY as direct child processes of the current Node binary
// (process.execPath, so the same Node that runs this script runs every step, no
// shell and no npm in between), with inherited stdout/stderr (each suite's own
// banner and totals stay visible as proof it actually ran) and IMMEDIATE nonzero
// exit on the first failing step.
//
// The step list is DERIVED from package.json's own script definitions (single
// source of truth): each suite script must be a chain of plain "node scripts/..."
// commands, and anything else fails closed rather than being skipped silently.
// Adding a test file to an existing npm script automatically adds it here.
//
// Run: node scripts/verify.mjs   (or: npm run verify)

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

// Verification order (the old chain's order, plus the poller suite). build:check
// stays LAST so a red test fails fast before the slow bundle build.
const SUITES = [
  "test:currency",
  "test:water-capability",
  "test:dashboard-transition",
  "test:session-stability",
  "test:boot-recovery",
  "test:boot-guard-behavior",
  "test:boundary-behavior",
  "test:hook-order",
  "test:fba-plan-config-brand-gate",
  "test:sku-movement-identifier-brand-scope",
  "test:permission-cache-window",
  "test:permission-cache-scope",
  "test:report-cache-io",
  "test:listing-health-advanced",
  "test:listing-health-advanced-regressions",
  "test:listing-health-v3-integration",
  "test:listing-health-v3-serve",
  "test:listing-health-v3-view",
  "test:listing-health-v3-materialize",
  "test:listing-health-v3-operation",
  "test:listing-health-v3-authorization",
  "test:listing-health-v3-ingestion",
  "test:listing-health-v3-authorization-binding",
  "test:fba-inventory-truncated",
  "test:fba-inventory-overflow",
  "test:fba-inventory-latest-snapshot",
  "test:fba-d1-guard",
  "test:account-onboarding",
  "test:account-onboarding-reconcile",
  "test:account-onboarding-upsert",
  "test:discovery-deferral",
  "test:discovery-scope-recovery",
  "test:account-onboarding-worker",
  "test:account-onboarding-bootstrap",
  "test:round11-publication-fence",
  "test:release-env-ordering",
  "test:source-readiness-isolation",
  "test:scheduler-oli-readiness-plan",
  "test:priority-partial-capability",
  "test:scheduler-partial-publication-ordering",
  "test:lhv3-cycle-bucket-migration",
  "test:report-materialization-registry",
  "test:scheduled-family-registry",
  "test:report-materialization-operation",
  "test:report-brandview-materialization",
  "test:brand-view-dependency-fingerprint",
  "test:brand-inventory-rebuild",
  "test:ads-provisional-tail",
  "test:ads-content-rev",
  "test:report-materialization-coverage",
  "test:report-readonly-serve",
  "test:brand-view-readonly",
  "test:listing-health-v3-finalize",
  "test:listing-health-v3-preflight-defer",
  "test:listing-health-v3-identity-guard",
  "test:lhv3-shared-inventory-date",
  "test:scheduler-v2-lhv3-workflow",
  "test:region-view",
  "test:regional-brand-view",
  "test:insights",
  "test:brand-view",
  "test:sync",
  "test:source-cache",
  "test:sync-engine",
  "test:report-derivation",
  "test:source-identity",
  "test:report-contracts",
  "test:oli-source-correction",
  "test:oli-continuation-ceiling",
  "test:source-tranche",
  "test:source-batching",
  "test:source-account-isolation",
  "test:source-tranche-budget",
  "test:source-registry",
  "test:source-fixpoint",
  "test:source-durable-model",
  "test:oli-dimensional",
  "test:oli-itemization",
  "test:oli-completeness-serve",
  "test:oli-operational-units",
  "test:oli-sales-estimate",
  "test:sku-movement",
  "test:sku-movement-integration",
  "test:sku-movement-identifier",
  "test:campaign-brand-mapping",
  "test:campaign-mapping-import",
  "test:campaign-map-capability-admin",
  "test:campaign-ads",
  "test:campaign-ads-view",
  "test:campaign-ads-golive",
  "test:campaign-ads-recovery",
  "test:campaign-ads-aggregation",
  "test:campaign-initial-window",
  "test:sku-movement-import",
  "test:sku-movement-rederive",
  "test:brand-authorization",
  "test:brand-scope-filter",
  "test:access-brand-scope",
  "test:report-registry-coverage",
  "test:returns-durable",
  "test:oli-value-policy",
  "test:oli-quality",
  "test:oli-order-audit",
  "test:effective-asof",
  "test:source-bucket-sync",
  "test:source-status",
  "test:admin-sources-boundary",
  "test:source-schedule",
  "test:zero-export-rehearsal",
  "test:source-production-hardening",
  "test:source-priority-dashboards",
  "test:scheduler-scope",
  "test:scheduler-regional-workflow",
  "test:scheduler-automation",
  "test:scheduler-bucket-independence",
  "test:scheduler-d1-freshness",
  "test:scheduler-superseding",
  "test:scheduler-hardening",
  "test:scheduler-recovery",
  "test:cloudflare-scheduler-watchdog",
  "test:asin-ads-aggregation",
  "test:daily-durable-rederive",
  "test:daily-v2-backfill",
  "test:source-sync-operation",
  "test:daily-v2-serving",
  "test:durable-live-parity",
  "test:schema-contract-mutation",
  "test:report-sync-controls",
  "test:gate5-canary-package",
  "test:datadoe-poll-export",
  "test:supabase-read-retry",
  "test:source-download-recovery",
  "test:source-create-reconcile",
  "test:daily-roi-format",
  "test:daily-view-model",
  "test:brand-sales-backfill",
  "test:brand-membership-scope",
  "test:brand-view-freshness",
  "test:brand-view-render",
  "test:fba-planning",
  "test:awd-europe",
  "test:fba-wdd",
  "test:fba-wdd-config",
  "test:warehouse-import",
  "test:warehouse-validation",
  "test:warehouse-ownership",
  "test:fba-plan-config-handler",
  "test:fba-plan-account-columns",
  "test:fba-plan-columns-hook",
  "test:fba-plan-column-registry",
  "test:fba-lead-time-import",
  "test:scoped-loader",
  "test:import-lifecycle",
  "test:fba-import-integration",
  "test:fba-plan-operation",
  "test:fba-regional-inventory",
  "test:plan-brand",
  "test:asin-ads-backfill-window",
  "test:manual-source-continuation",
  "test:cycle-lifecycle",
  "test:cycle-finalize-wiring",
  "test:timeout-slicing",
  "test:ads-sync-canary",
  "test:gate7-rollout-publisher",
  "test:gate7b-in-cutover",
  "build:check",
];

// Expand each npm script into its "node scripts/<file>" steps; fail closed on a
// missing script or any step this runner would not know how to execute.
const steps = [];
for (const name of SUITES) {
  const script = (pkg.scripts || {})[name];
  if (!script) {
    console.error(`verify: package.json has no script "${name}" (fail closed)`);
    process.exit(1);
  }
  for (const part of script.split("&&").map((s) => s.trim()).filter(Boolean)) {
    const m = /^node (scripts\/[A-Za-z0-9._/-]+)$/.exec(part);
    if (!m) {
      console.error(`verify: script "${name}" contains a step this runner cannot execute: "${part}" (fail closed)`);
      process.exit(1);
    }
    steps.push({ suite: name, file: m[1] });
  }
}

const startedAt = Date.now();
let i = 0;
for (const { suite, file } of steps) {
  i += 1;
  console.log(`\n[verify ${i}/${steps.length}] (${suite}) node ${file}`);
  const r = spawnSync(process.execPath, [path.join(root, file)], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\nverify: FAILED at ${file} (${r.status === null ? `signal ${r.signal}` : `exit ${r.status}`})`);
    process.exit(r.status === null ? 1 : r.status);
  }
}
console.log(`\nverify: all ${steps.length} steps passed across ${SUITES.length} suites (incl. build:check) in ${Math.round((Date.now() - startedAt) / 1000)}s`);
