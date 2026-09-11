// ENTRYPOINT + WORKFLOW guards for the ZERO-EXPORT Campaign-Ads reconciler (WORK A). Source-scans
// scripts/release/ads-publication-reconcile.mjs + .github/workflows/ads-publication-reconcile.yml to prove: the
// entrypoint drives the REPORT-SPECIFIC buildAdsReportReconciler (per Codex blocker 5) via the reviewed priority
// release for daily-reporting; zero DataDoe export is STRUCTURAL (a create/poll/download-refusing inner adapter + no
// export transport symbol imported); the reviewed priority-partial namespace + control lifecycle (immediate renews the
// scheduler fence; periodic apply + always safe-close; COMMIT_UNKNOWN handling; evidence-based closure) + cooperative
// deadline + settlement + --cleanup; and the workflow is DRY-RUN unless ADS_RECONCILE_LIVE=='true' (scheduled) / the
// manual 'live' input, sequential regions, bounded < 30 min, least-privilege. 7-bit ASCII, LF. ZERO I/O beyond reads.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "ads-publication-reconciler\n");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const mjs = readFileSync(path.join(here, "release", "ads-publication-reconcile.mjs"), "utf8");
const yml = readFileSync(path.join(repoRoot, ".github/workflows/ads-publication-reconcile.yml"), "utf8");
const wrapper = readFileSync(path.join(here, "..", "lib/server/sync/ads-publication-reconciler.js"), "utf8");
const revision = readFileSync(path.join(here, "..", "lib/server/sync/ads-publication-revision.js"), "utf8");

// ---- ENTRYPOINT: report-specific reconciler via the reviewed priority release; structural zero export ----
ok("entrypoint drives buildAdsReportReconciler (report-specific operation, blocker 5)", /buildAdsReportReconciler\(/.test(mjs) && /buildOperation\("daily-reporting"/.test(mjs));
ok("daily-reporting re-derives from the FULL union via the reviewed priority release + runner", /buildPriorityDashboardsRelease\(/.test(mjs) && /runPriorityDashboardsRelease\(/.test(mjs));
ok("NO real provider export/token transport symbol in the entrypoint", !/createExport\(/.test(mjs) && !/makeDataDoeAdapter/.test(mjs) && !/exportsCreate/.test(mjs) && !/reserveTokens/.test(mjs) && !/source-sync-driver/.test(mjs));
ok("structural zero export: the inner adapter REFUSES create/poll/download", /ADS_RECONCILER_NO_EXPORT/.test(mjs) && /makeNoExportInnerAdapter/.test(mjs) && (mjs.match(/ADS_RECONCILER_NO_EXPORT/g) || []).length >= 3);
ok("durable Ads evidence read via getDailyAdsCoverage (durable coverage + content_rev; zero export)", /getDailyAdsCoverage\(/.test(mjs) && /readAdsCoverageState/.test(mjs));
ok("DEFECT-1 GUARD: coverage read translates the REGISTRY grain to the durable WORKER key (adsWorkerKeyForGrain); token stays registry-keyed", /adsWorkerKeyForGrain/.test(mjs) && /getDailyAdsCoverage\(accountId, adsWorkerKeyForGrain\(sourceKey\)\)/.test(mjs) && !/getDailyAdsCoverage\(accountId, sourceKey\)/.test(mjs));
ok("marketplace resolved from the authoritative directory (isolation) + threaded to the revision", /resolveMarketplace/.test(mjs));

// ---- reviewed namespace + control lifecycle (identical posture to OLI/FBA) ----
ok("cycle bucket is priority-partial-<region>-<16hex> over {accountId, revisionId}", /"priority-partial-" \+ b \+ "-" \+ sha256\(JSON\.stringify\(\[accountId, revisionId/.test(mjs));
ok("readPartialCycleCapability gates the namespace (fail closed)", /readPartialCycleCapability\(/.test(mjs) && /PRIORITY_PARTIAL_MIGRATION_PENDING/.test(mjs));
ok("immediate renews the scheduler fence; periodic apply + rollback safe-close; never a standalone acquire", /renewControlPlaneLease\(\{ ownerToken: runToken, generation: ownerGeneration/.test(mjs) && /runControlPackageCli\(\{[\s\S]{0,120}mode: "apply"/.test(mjs) && /runControlPackageCli\(\{ mode: "rollback"/.test(mjs) && !/acquireControlLease\(/.test(mjs));
ok("apply + safe-close detect COMMIT_UNKNOWN (code 3)", (mjs.match(/COMMIT_UNKNOWN \(code 3\)/g) || []).length >= 2 && /commitUnknown: true/.test(mjs));
ok("evidence-based closure (readControlPlaneClosed + require proven closed)", /async function readControlPlaneClosed\(\)/.test(mjs) && /CONTROLLED_REPORT_KEYS/.test(mjs) && /if \(!state\.closed\) return \{ ok: false/.test(mjs));
ok("typed threading of the runner classification (status/leaseLost/reason)", /status: result\.status/.test(mjs) && /leaseLost: result\.leaseLost === true/.test(mjs) && /reason: result\.reason/.test(mjs));
ok("cooperative deadline (--deadline-seconds -> outOfTime) + settlement + --cleanup reclaim; REQUIRED (ref'd) timers", /deadline-seconds/.test(mjs) && /const outOfTime = \(\)/.test(mjs) && /awaitSettled/.test(mjs) && /settled: false/.test(mjs) && /--cleanup/.test(mjs) && /mode: "reclaim"/.test(mjs) && !/\.unref\s*\(\s*\)/.test(mjs));
ok("aborted op -> null fence + verifyLease not-owned (no write after deadline)", /getControlFence: \(\) => \(aborted\(\) \? null : leaseFence\)/.test(mjs) && /const verifyLeaseForOp = async \(\) => \(aborted\(\) \? \{ ok: false/.test(mjs));
ok("DRY-RUN default; openControls/closeControls no-ops under dry-run (zero writes)", /const dryRun = !live/.test(mjs) && /openControls: dryRun \? \(async \(\) => \(\{ ok: true \}\)\) : openControls/.test(mjs) && /closeControls: dryRun \? \(async \(\) => \(\{ ok: true \}\)\) : closeControls/.test(mjs));
ok("RESULT reports zero DataDoe creates/tokens", /dataDoeCreates: 0, dataDoeTokens: 0/.test(mjs));

// ---- report-specific isolation is enforced in the wrapper + revision (blocker 5) ----
ok("wrapper builds a SINGLE-report operation (reportKeys:[reportKey]); daily reads only its required grains", /reportKeys: \[reportKey\]/.test(wrapper) && /ONLY this report's required grains/.test(wrapper));
ok("revision is report-specific (requiredGrains) with strict continuous coverage + no MAX(covered_to)", /computeAdsReportRevision/.test(revision) && /coverageProvesContinuousRange/.test(revision) && !/maxCoveredThrough/.test(revision));

// ---- WORKFLOW: dry-run default, ADS_RECONCILE_LIVE gating, sequential regions, bounded, least-privilege ----
ok("workflow: scheduled runs dry-run unless vars.ADS_RECONCILE_LIVE == 'true'", /vars\.ADS_RECONCILE_LIVE == 'true' && 'live' \|\| 'dry-run'/.test(yml));
ok("workflow: manual dispatch defaults to dry-run", /default: "dry-run"/.test(yml));
ok("workflow: cleanup gates on effective-live EXACTLY (manual dry-run never cleans even if the repo flag is set)", /github\.event\.inputs\.mode == 'live'/.test(yml) && /github\.event_name != 'workflow_dispatch' && vars\.ADS_RECONCILE_LIVE == 'true'/.test(yml));
ok("workflow: regions processed sequentially in ONE job (for REGION in india europe-au us-ca)", /for REGION in india europe-au us-ca/.test(yml) && /timeout 420 node scripts\/release\/ads-publication-reconcile\.mjs/.test(yml) && /--deadline-seconds=330/.test(yml));
ok("workflow: concurrency prevents overlap (no cancel) + bounded < 30 min", /group: ads-publication-reconcile/.test(yml) && /cancel-in-progress: false/.test(yml) && /timeout-minutes: 25/.test(yml));
ok("workflow: off-boundary cron staggered from OLI (:17/:47)", /cron: "17,47 \* \* \* \*"/.test(yml));
ok("workflow: least-privilege (contents: read), no actions:write", /permissions:[\s\S]{0,240}contents: read/.test(yml) && !/actions: write/.test(yml));

writeSync(1, `\nads-publication-reconciler: ${passed} assertions passed\n`);
