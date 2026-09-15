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

// ---- ENTRYPOINT: report-specific reconciler via the DEDICATED daily-only release; structural zero export ----
const rel = readFileSync(path.join(here, "..", "lib/server/sync/daily-reporting-release.js"), "utf8");
ok("entrypoint drives buildAdsReportReconciler (report-specific operation, blocker 5)", /buildAdsReportReconciler\(/.test(mjs) && /buildOperation\("daily-reporting"/.test(mjs));
// SCOPE (P0 fix): daily-reporting re-derives via the DEDICATED daily-only release (buildDailyReportingRelease.runForAccount
// through the fenced buildSchedulerV2Publisher) -- NEVER the priority TRIO release (which would derive+publish brand-sales
// + brand-inventory too). A regression that reintroduces the trio fails CI.
ok("daily-reporting re-derives via the DEDICATED daily-only release (never the trio)", /buildDailyReportingRelease\(/.test(mjs) && /release\.runForAccount\(/.test(mjs) && /buildSchedulerV2Publisher\(/.test(mjs) && !/buildPriorityDashboardsRelease/.test(mjs) && !/runPriorityDashboardsRelease/.test(mjs) && !/source-priority-dashboards/.test(mjs));
ok("the dedicated release module targets ONLY daily-reporting (reportKeys:[daily-reporting]; no QUOTED sibling report-key or sibling shadow-key)", /reportKeys: \[DAILY_REPORT_KEY\]/.test(rel) && /DAILY_REPORT_KEY = "daily-reporting"/.test(rel) && !/"brand-sales"/.test(rel) && !/"brand-inventory"/.test(rel) && !/scheduler-v2\/brand-/.test(rel) && !/reportDerivations\["brand/.test(rel));
ok("NO real provider export/token transport symbol in the entrypoint OR the dedicated release (structural zero export)", [mjs, rel].every((s) => !/createExport\(/.test(s) && !/makeDataDoeAdapter/.test(s) && !/exportsCreate/.test(s) && !/reserveTokens/.test(s) && !/source-sync-driver/.test(s)) && !/from "\.\.\/datadoe/.test(rel));
ok("structural zero export: no throwing inner adapter, no export transport reachable from the release path", !/makeNoExportInnerAdapter/.test(mjs) && !/ADS_RECONCILER_NO_EXPORT/.test(mjs) && !/makeInnerAdapter/.test(mjs));
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
ok("workflow: one daily recovery cron, staggered after OLI/FBA", /cron: "23 21 \* \* \*"/.test(yml));
ok("workflow: disabled scheduled recovery allocates no runner; manual dispatch remains available", /if: github\.event_name == 'workflow_dispatch' \|\| vars\.ADS_RECONCILE_LIVE == 'true'/.test(yml));
ok("workflow: least-privilege (contents: read), no actions:write", /permissions:[\s\S]{0,240}contents: read/.test(yml) && !/actions: write/.test(yml));

// ---- IMMEDIATE HOOK (WORK A item 6): scheduler-v2.yml runs the daily Ads reconcile in a post-run job, zero-export,
// dry-run unless ADS_RECONCILE_LIVE, self-owned lease (periodic mode), gated inside the duplicate-run suppression graph.
const schedYml = readFileSync(path.join(repoRoot, ".github/workflows/scheduler-v2.yml"), "utf8");
ok("scheduler-v2: a dedicated ads_reconcile job runs after run+fba, gated on execute_downstream + token gate + non-bootstrap", /\n {2}ads_reconcile:\n[\s\S]{0,400}needs: \[run, fba\][\s\S]{0,400}needs\.run\.outputs\.execute_downstream == 'true'[\s\S]{0,120}needs\.run\.outputs\.token_proceed == 'true'[\s\S]{0,120}needs\.run\.outputs\.scope != 'bootstrap'/.test(schedYml));
ok("scheduler-v2: the immediate hook runs ONLY ads-publication-reconcile.mjs (periodic, deadline-bounded) -- zero export", /ads_reconcile:[\s\S]{0,1600}node scripts\/release\/ads-publication-reconcile\.mjs --bucket=\$\{\{ needs\.run\.outputs\.region \}\} --as-of=\$\{\{ needs\.run\.outputs\.effective_asof \}\} --mode=periodic --deadline-seconds=300/.test(schedYml));
ok("scheduler-v2: the immediate hook is DRY-RUN unless vars.ADS_RECONCILE_LIVE == 'true' (mirrors OLI/FBA hooks)", /ads_reconcile:[\s\S]{0,1600}vars\.ADS_RECONCILE_LIVE }}" = "true" \]; then LIVE="--live"/.test(schedYml) && /ads_reconcile:[\s\S]{0,1600}continue-on-error: true/.test(schedYml));

writeSync(1, `\nads-publication-reconciler: ${passed} assertions passed\n`);
