// scheduler-v2 Listing Health v3 shadow-job SOURCE GUARDS -- Phases 1/4/5.
//
// Static assertions over .github/workflows/scheduler-v2.yml (+ feature-flags.js + the region ceiling constant): the v3
// shadow job depends on [run, fba], runs only on a resolved region + fba success, shares ONE inventory_asof between the
// FBA and v3 commands (never recomputing UTC today downstream), keeps the ceilings, enables the ingestion env gate ONLY
// in its own job, never flips the UI flag, and adds NO second scheduler/cron owner. 7-bit ASCII, LF. ZERO I/O beyond
// reading repo files.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LISTING_HEALTH_V3_REGION_EXPORT_CEILING } from "../lib/server/sync/listing-health-v3-materialize.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "scheduler-v2-lhv3-workflow\n");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const wf = readFileSync(path.join(repoRoot, ".github/workflows/scheduler-v2.yml"), "utf8");
const flags = readFileSync(path.join(here, "..", "src/lib/feature-flags.js"), "utf8");
const fbaGolive = readFileSync(path.join(here, "release", "fba-plan-golive.mjs"), "utf8");

// Isolate the listing-health-v3 job block (from its key to the NEXT job key, if any).
const v3Idx = wf.indexOf("\n  listing-health-v3:");
assert.ok(v3Idx > 0, "the workflow defines a listing-health-v3 job");
const matCommentIdx = wf.indexOf("\n  # Report materialization");
const matIdx = wf.indexOf("\n  materialize:");
// The SEPARATE listing_health_v3_reconcile job (WORK C immediate hook) sits between the v3 SHADOW job and the
// materialize job; its leading comment precedes its job key. End the v3 SHADOW block at whichever of these markers
// comes FIRST after v3Idx, so neither the reconcile job's docs (it legitimately calls the zero-export reconciler with
// --as-of) nor the materialize job's docs leak into the v3 SHADOW export-contract assertions below.
const reconcileCommentIdx = wf.indexOf("\n  # IMMEDIATE post-ingestion listing-health-v3 publication reconcile");
const reconcileIdx = wf.indexOf("\n  listing_health_v3_reconcile:");
const candidates = [matCommentIdx, matIdx, reconcileCommentIdx, reconcileIdx].filter((i) => i > v3Idx);
const v3End = candidates.length ? Math.min(...candidates) : wf.length;
const v3Job = wf.slice(v3Idx, v3End);
const beforeV3 = wf.slice(0, v3Idx); // run + fba jobs
// The zero-export per-account report materialization job, bounded at the START of the FBA-aware brand-view block.
const matInvCommentIdx = wf.indexOf("\n  # FBA-aware Brand View materialization");
const matInvIdx = wf.indexOf("\n  materialize-inventory:");
const matEnd = matInvCommentIdx > matIdx ? matInvCommentIdx : (matInvIdx > matIdx ? matInvIdx : wf.length);
const matJob = matIdx > 0 ? wf.slice(matIdx, matEnd) : "";
// The FBA-aware Brand View materialization job (the missing backend producer for brand-view + brand-view-portfolio),
// bounded at the START of the bootstrap-ack block (the onboarding dispatch acknowledgement job that follows it).
const ackCommentIdx = wf.indexOf("\n  # BOOTSTRAP ack (completed | failed)");
const ackIdx = wf.indexOf("\n  bootstrap-ack:");
const matInvEnd = ackCommentIdx > matInvIdx ? ackCommentIdx : (ackIdx > matInvIdx ? ackIdx : wf.length);
const matInvJob = matInvIdx > 0 ? wf.slice(matInvIdx, matInvEnd) : "";

/* ===================== A. dependency order + gate (optional-inventory: run regardless of FBA outcome) =========== */
ok("A: the v3 job needs BOTH run and fba (ordering only)", /needs:\s*\[run,\s*fba\]/.test(v3Job));
ok("A: optional-inventory -- the v3 gate depends on the PRIORITY RUN succeeding (OLI + inventory_asof), NOT on the FBA publish outcome",
  /needs\.run\.result\s*==\s*'success'/.test(v3Job) && /needs\.run\.outputs\.region\s*!=\s*''/.test(v3Job) && /needs\.run\.outputs\.scope\s*!=\s*'bootstrap'/.test(v3Job));
ok("A: optional-inventory -- the v3 gate no longer requires fba success or a published-count/threshold (FBA=0 still runs v3)",
  !/needs\.fba\.result\s*==\s*'success'/.test(v3Job) && !/needs\.fba\.outputs\.fba_published/.test(v3Job));
ok("A: `always()` so fba's result (partial / crash / zero-published) never SKIPS v3", /if:\s*always\(\)/.test(v3Job));
ok("A: the fba job still EXPOSES fba_published as a job output (observability) mapped from the id'd golive step",
  /\n  fba:\n[\s\S]*?outputs:\s*\n[\s\S]*?fba_published:\s*\$\{\{\s*steps\.fba\.outputs\.fba_published\s*\}\}/.test(beforeV3) && /id:\s*fba\b/.test(beforeV3));
// The fba golive writer emits fba_published as a BOOLEAN string (hygiene; it is an observability output now, but a
// count would be misleading). Kept as a guard against silent drift back to String(anyPublished).
ok("A: the fba golive writer emits fba_published as a BOOLEAN (anyPublished > 0), not the numeric count",
  /ghOut\("fba_published",\s*anyPublished\s*>\s*0\s*\?\s*"true"\s*:\s*"false"\)/.test(fbaGolive) && !/ghOut\("fba_published",\s*String\(anyPublished\)\)/.test(fbaGolive));
ok("A: the fba job itself only needs run (v3 runs strictly after fba)", /^\s{2}fba:\s*$/m.test(wf) && /\n  fba:\n[\s\S]*?needs:\s*run\b/.test(wf));

/* ===================== B. ONE shared inventory_asof (D-1, = asof), computed once, consumed by BOTH ===================== */
ok("B: inventory_asof is bound exactly once to the D-1 asof in the cfg step (never recomputed)", /inventory_asof="\$asof"/.test(wf) && (wf.match(/inventory_asof="/g) || []).length === 1);
ok("B: inventory_asof is exposed as a run-job output", /inventory_asof:\s*\$\{\{\s*steps\.cfg\.outputs\.inventory_asof\s*\}\}/.test(wf));
ok("B: the D-1 asof output is unchanged (yesterday, for OLI/Ads)", /asof="\$\(date -u -d 'yesterday' \+%Y-%m-%d\)"/.test(wf));
ok("B: the FBA command receives the shared inventory_asof", /fba-plan-golive\.mjs[^\n]*--inventory-as-of=\$\{\{\s*needs\.run\.outputs\.inventory_asof\s*\}\}/.test(wf));
ok("B: the v3 command's --cycle-date is the SAME shared inventory_asof", /listing-health-v3-ingestion\.mjs[^\n]*--cycle-date=\$\{\{\s*needs\.run\.outputs\.inventory_asof\s*\}\}/.test(v3Job));
ok("B: the v3 --confirm operation id uses region + the SAME inventory_asof", /--confirm=listing-health-v3\/\$\{\{\s*needs\.run\.outputs\.region\s*\}\}\/\$\{\{\s*needs\.run\.outputs\.inventory_asof\s*\}\}/.test(v3Job));
ok("B: the v3 job NEVER recomputes UTC today (no date -u inside the v3 job)", !/date -u/.test(v3Job));

/* ===================== C. env gate scoped to the v3 job; UI flag never touched ===================== */
ok("C: LISTING_HEALTH_V3_INGESTION_ENABLED=true is set (ingestion gate)", /LISTING_HEALTH_V3_INGESTION_ENABLED:\s*"true"/.test(v3Job));
ok("C: the ingestion gate appears ONLY in the v3 job (not the run/fba jobs)", !/LISTING_HEALTH_V3_INGESTION_ENABLED/.test(beforeV3));
ok("C: the workflow NEVER sets/flips the UI flag LISTING_HEALTH_V3 (exact env, not the _INGESTION_ suffix)", !/LISTING_HEALTH_V3\s*:/.test(wf) && !/LISTING_HEALTH_V3=/.test(wf));
ok("C: the UI flag stays OFF in source", /export const LISTING_HEALTH_V3 = false;/.test(flags));
ok("C: the v3 job pins the reviewed operator identity", /PRIORITY_OPERATOR:\s*laxmikant@superboring\.in/.test(v3Job));
ok("C: the v3 job runs mode=live for the resolved region", /--mode=live/.test(v3Job) && /--region=\$\{\{\s*needs\.run\.outputs\.region\s*\}\}/.test(v3Job));

/* ===================== D. no second cron / scheduler owner ===================== */
ok("D: exactly ONE schedule block + exactly the three existing regional crons", (wf.match(/on:\n\s*schedule:/g) || []).length === 1 && (wf.match(/- cron:/g) || []).length === 3);
ok("D: the three regional primaries (off-boundary: india 03:07 / europe-au 08:37 / us-ca 16:37 UTC)", wf.includes('- cron: "7 3 * * *"') && wf.includes('- cron: "37 8 * * *"') && wf.includes('- cron: "37 16 * * *"'));
ok("D: the v3 job adds NO cron / schedule / workflow_dispatch of its own", !/cron:|schedule:|workflow_dispatch:/.test(v3Job));
ok("D: the workflow-level per-region concurrency group is preserved (shared by all jobs incl. v3)", /concurrency:\n\s*#[\s\S]*?group:\s*scheduler-v2-/.test(wf) && /cancel-in-progress:\s*false/.test(wf));

/* ===================== E. ceilings unchanged; inventory/OLI/catalog remain zero-create ===================== */
ok("E: the region export ceilings are India=4, Europe-AU=8, US-CA=4", LISTING_HEALTH_V3_REGION_EXPORT_CEILING.india === 4 && LISTING_HEALTH_V3_REGION_EXPORT_CEILING["europe-au"] === 8 && LISTING_HEALTH_V3_REGION_EXPORT_CEILING["us-ca"] === 4);
ok("E: the v3 command creates ONLY via the ingestion CLI (Listings + Listings-Raw; inventory reuse-only by contract)", /listing-health-v3-ingestion\.mjs/.test(v3Job) && !/--as-of=|fba-inventory|order-line|catalog|campaign|awd/i.test(v3Job));

/* ===================== F. the zero-export report materialization job (Phase 3) ===================== */
ok("F: a materialize job exists", matJob.length > 0 && /^\s{2}materialize:\s*$/m.test(matJob));
ok("F: materialize depends ONLY on run (NOT fba) so an FBA failure never blocks sales/returns reports", /needs:\s*\[run\]/.test(matJob) && !/needs:\s*\[run,\s*fba\]/.test(matJob));
ok("F: materialize runs if:always on a resolved region (independent of fba result)", /if:\s*always\(\)\s*&&\s*needs\.run\.outputs\.region\s*!=\s*''/.test(matJob) && !/needs\.fba\.result/.test(matJob));
ok("F: materialize invokes the zero-export report-materialization CLI in live mode for the region", /report-materialization\.mjs[^\n]*--mode=live/.test(matJob) && /report-materialization\.mjs[^\n]*--region=\$\{\{\s*needs\.run\.outputs\.region\s*\}\}/.test(matJob));
ok("F: materialize passes the SHARED inventory_asof ceiling (never recomputes UTC today)", /report-materialization\.mjs[^\n]*--as-of=\$\{\{\s*needs\.run\.outputs\.inventory_asof\s*\}\}/.test(matJob) && !/date -u/.test(matJob));
ok("F: materialize creates NO DataDoe export CLI / cron / dispatch (it never spends a token)", !/ingestion\.mjs|fba-plan-golive\.mjs|cron:|schedule:|workflow_dispatch:/.test(matJob));
ok("F: materialize does NOT enable the ingestion gate or flip the UI flag", !/LISTING_HEALTH_V3_INGESTION_ENABLED/.test(matJob) && !/LISTING_HEALTH_V3\s*:/.test(matJob));

/* ===================== G. the FBA-aware Brand View materialization job (Phase 3 Completion) ===================== */
ok("G: a materialize-inventory job exists", matInvJob.length > 0 && /^\s{2}materialize-inventory:\s*$/m.test(matInvJob));
ok("G: it depends on [run, fba, materialize] (runs AFTER inventory + the base materializer)", /needs:\s*\[run,\s*fba,\s*materialize\]/.test(matInvJob));
ok("G: it runs if:always on a resolved region and NEVER gates on fba success (so an FBA failure still publishes sales/Ads)",
  /if:\s*always\(\)\s*&&\s*needs\.run\.outputs\.region\s*!=\s*''/.test(matInvJob) && !/needs\.fba\.result/.test(matInvJob));
ok("G: it invokes the zero-export Brand View materializer CLI in live mode for the region",
  /report-materialization-brandview\.mjs[^\n]*--mode=live/.test(matInvJob) && /report-materialization-brandview\.mjs[^\n]*--region=\$\{\{\s*needs\.run\.outputs\.region\s*\}\}/.test(matInvJob));
ok("G: it creates NO DataDoe export CLI / cron / dispatch (never spends a token)", !/ingestion\.mjs|fba-plan-golive\.mjs|cron:|schedule:|workflow_dispatch:/.test(matInvJob));
ok("G: it does NOT enable the ingestion gate or flip the UI flag", !/LISTING_HEALTH_V3_INGESTION_ENABLED/.test(matInvJob) && !/LISTING_HEALTH_V3\s*:/.test(matInvJob));
ok("G: it recomputes NO date (Brand View asOf is derived from marketplaceToday, not a workflow date)", !/date -u/.test(matInvJob));

writeSync(1, `\nscheduler-v2-lhv3-workflow: ${passed} assertions passed\n`);
