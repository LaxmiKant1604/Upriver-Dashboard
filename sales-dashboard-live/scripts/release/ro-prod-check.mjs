// THROWAWAY STAGE-AWARE read-only production check (Scheduler-v2 release).
// Usage:  node scripts/release/ro-prod-check.mjs <stage 0..8>   (run from sales-dashboard-live/)
// Validates the PINNED approved identity before connecting; reads under BEGIN ISOLATION LEVEL REPEATABLE READ
// READ ONLY (snapshot-consistent); verifies the exact ledger prefix, the exact catalog for the applied prefix,
// the approved control invariants, and the protected customer-data digest. Stage 0 creates the manifest-pinned baseline
// ATOMICALLY (exclusive, no-overwrite) ONLY after every assertion passes AND the read-only txn is rolled back.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { validateIdentity } from "./release-manifest.mjs";
import { APPROVED_INVARIANTS } from "./release-manifest.mjs";
import { verifyLedgerForStage, verifyStageObjects, verifyApprovedInvariants, captureProtectedDigest, compareProtectedDigest, requirePinnedStage0Digest, beginReadOnlySnapshot, buildBaseline, validateBaseline, validateStage3Baseline, validateStage4Baseline, validateStage6Baseline, validateStage7Baseline, validateStage8Baseline, shouldCreateBaseline } from "./release-state.mjs";
import { parseEnv, readGitHead, manifestFingerprint, envProjectRef } from "./release-fs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..", "..");
const repoRoot = path.resolve(appRoot, "..");
const envPath = path.resolve(repoRoot, ".env.local");
const baselineStage0Path = path.join(here, ".release-baseline.json");
const baselineStage3Path = path.join(here, ".release-baseline-stage3.json");
const baselineStage4Path = path.join(here, ".release-baseline-stage4.json");
const baselineStage6Path = path.join(here, ".release-baseline-stage6.json");
const baselineStage7Path = path.join(here, ".release-baseline-stage7.json");
const baselineStage8Path = path.join(here, ".release-baseline-stage8.json");

const args = process.argv.slice(2);
if (args.length !== 1 || !/^[0-9]$/.test(args[0])) { console.error("STOP usage: node scripts/release/ro-prod-check.mjs <stage 0..9>"); process.exit(2); }
const STAGE = Number(args[0]);

const env = parseEnv(readFileSync(envPath, "utf8"));
const id = validateIdentity(env);
console.log(`IDENTITY  approved_ref=${id.projectRef} supabase_host=${id.supaHost} postgres_host=${id.pgHost} ok=${id.ok}`);
if (!id.ok) { console.error("STOP identity: " + id.problems.join("; ")); process.exit(1); }

const currentHead = readGitHead(path.join(repoRoot, ".git"));
const currentFingerprint = manifestFingerprint(here);
const envRef = envProjectRef(env);

const u = new URL(env.POSTGRES_URL); u.searchParams.set("sslmode", "no-verify");
const client = new pg.Client({ connectionString: u.toString() });
const q = (text, params) => client.query(text, params);
await client.connect();

let problems = [];
let digest = null;
let rolledBack = false;
try {
  await beginReadOnlySnapshot(client); // BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY
  problems.push(...await verifyLedgerForStage(q, STAGE));
  problems.push(...await verifyApprovedInvariants(q, APPROVED_INVARIANTS));
  problems.push(...await verifyStageObjects(q, STAGE));
  digest = await captureProtectedDigest(q);
  console.log(`PROTECTED live=${digest.live_snapshots.c} shadow=${digest.shadow_snapshots.c}`);
  if (STAGE === 0) {
    // Blocker 2: the observed customer-data digest MUST equal the pinned manifest value before a baseline exists.
    problems.push(...requirePinnedStage0Digest(digest));
  } else if (STAGE >= 8) {
    // Stage 8+ is governed by the reviewed STAGE-8 re-anchor baseline (forward-only recovery for migration 9).
    let baseline = null;
    try { baseline = JSON.parse(readFileSync(baselineStage8Path, "utf8")); } catch { problems.push("stage-8 baseline file missing/malformed (run `node scripts/release/re-anchor-stage8.mjs` first)"); }
    if (baseline) {
      problems.push(...validateStage8Baseline(baseline, { currentHead, currentFingerprint, envRef }));
      problems.push(...compareProtectedDigest(baseline.protectedDigest, digest));
    }
  } else if (STAGE === 7) {
    // Stage 7 is governed by the reviewed STAGE-7 re-anchor baseline (forward-only recovery for migration 8).
    let baseline = null;
    try { baseline = JSON.parse(readFileSync(baselineStage7Path, "utf8")); } catch { problems.push("stage-7 baseline file missing/malformed (run `node scripts/release/re-anchor-stage7.mjs` first)"); }
    if (baseline) {
      problems.push(...validateStage7Baseline(baseline, { currentHead, currentFingerprint, envRef }));
      problems.push(...compareProtectedDigest(baseline.protectedDigest, digest));
    }
  } else if (STAGE === 6) {
    // Stage 6 remains governed by the STAGE-6 re-anchor baseline (forward-only recovery for migration 7).
    let baseline = null;
    try { baseline = JSON.parse(readFileSync(baselineStage6Path, "utf8")); } catch { problems.push("stage-6 baseline file missing/malformed (run `node scripts/release/re-anchor-stage6.mjs` first)"); }
    if (baseline) {
      problems.push(...validateStage6Baseline(baseline, { currentHead, currentFingerprint, envRef }));
      problems.push(...compareProtectedDigest(baseline.protectedDigest, digest));
    }
  } else if (STAGE >= 4) {
    // Stages 4-5 are governed by the reviewed STAGE-4 re-anchor baseline (forward-only recovery).
    let baseline = null;
    try { baseline = JSON.parse(readFileSync(baselineStage4Path, "utf8")); } catch { problems.push("stage-4 baseline file missing/malformed (run `node scripts/release/re-anchor-stage4.mjs` first)"); }
    if (baseline) {
      problems.push(...validateStage4Baseline(baseline, { currentHead, currentFingerprint, envRef }));
      problems.push(...compareProtectedDigest(baseline.protectedDigest, digest));
    }
  } else if (STAGE === 3) {
    // Stage 3 remains governed by the STAGE-3 re-anchor baseline (historical audit; unchanged).
    let baseline = null;
    try { baseline = JSON.parse(readFileSync(baselineStage3Path, "utf8")); } catch { problems.push("stage-3 baseline file missing/malformed (run `node scripts/release/re-anchor-stage3.mjs` first)"); }
    if (baseline) {
      problems.push(...validateStage3Baseline(baseline, { currentHead, currentFingerprint, envRef }));
      problems.push(...compareProtectedDigest(baseline.protectedDigest, digest));
    }
  } else {
    // Stages 1-2 remain governed by the stage-0 baseline (legacy path).
    let baseline = null;
    try { baseline = JSON.parse(readFileSync(baselineStage0Path, "utf8")); } catch { problems.push("baseline file missing/malformed (run stage 0 first)"); }
    if (baseline) {
      problems.push(...validateBaseline(baseline, { currentHead, currentFingerprint, envRef }));
      problems.push(...compareProtectedDigest(baseline.protectedDigest, digest));
    }
  }
} catch (e) {
  problems.push("query error: " + e.message);
} finally {
  try { await client.query("ROLLBACK"); rolledBack = true; } catch { rolledBack = false; }
  await client.end();
}

if (problems.length) { console.error(`STOP stage ${STAGE} — ${problems.length} mismatch(es):`); for (const p of problems) console.error("  - " + p); process.exit(1); }

// Blocker 1: create the manifest-pinned baseline ONLY after every assertion passed AND the read-only txn rolled back,
// atomically with exclusive/no-overwrite semantics.
if (STAGE === 0 && !rolledBack) { console.error("STOP read-only transaction did not roll back cleanly; refusing to create baseline"); process.exit(1); }
if (shouldCreateBaseline({ stage: STAGE, problemCount: problems.length, rolledBack })) {
  const baseline = buildBaseline({ head: currentHead, fingerprint: currentFingerprint }); // manifest-pinned values ONLY
  try {
    writeFileSync(baselineStage0Path, JSON.stringify(baseline, null, 2), { flag: "wx" }); // exclusive create; never overwrite
    console.log(`BASELINE  created ${path.basename(baselineStage0Path)} (head=${currentHead.slice(0, 12)} fp=${currentFingerprint.slice(0, 12)})`);
  } catch (e) {
    if (e && e.code === "EEXIST") { console.error("STOP baseline already exists — refusing to overwrite (remove the reviewed baseline to recreate)"); process.exit(1); }
    console.error("STOP baseline write failed: " + e.message); process.exit(1);
  }
}
console.log(`RESULT    stage ${STAGE} OK`);
process.exit(0);
