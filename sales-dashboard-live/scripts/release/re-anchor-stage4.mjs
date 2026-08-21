// THROWAWAY DEDICATED stage-4 re-anchor (Scheduler-v2 release; forward-only recovery from an APPLIED stage 4).
// Usage:  node scripts/release/re-anchor-stage4.mjs   (run from sales-dashboard-live/)
//
// This is NOT a generic "baseline at any stage": the anchor is HARD-CODED to 4. It is strictly READ-ONLY --
// validates the pinned approved identity BEFORE connecting; reads under BEGIN ISOLATION LEVEL REPEATABLE READ
// READ ONLY; requires the EXACT stage-4 production state (ledger = base + migrations 1-4 once each AND 5-6
// absent; the COMPLETE CUMULATIVE catalog for migrations 1-4 -- incl. the migration-4 ALTER-added
// source_batch_membership_account_canonical constraint; migrations 5-6 target objects absent; all EIGHT
// protected digests EQUAL the existing manifest pins exactly; rollout/settings/approvals/cron/dfca8f75
// invariants exactly); ALWAYS ROLLBACK; then creates a SEPARATE stage-4 baseline file
// (.release-baseline-stage4.json) with exclusive/no-overwrite semantics, bound to the final HEAD, the corrected
// manifest fingerprint, all six frozen migration hashes, the approved project identity and anchorStage=4. The
// stage-0 and stage-3 baselines are left UNTOUCHED for audit. It NEVER captures arbitrary current state.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { validateIdentity, APPROVED_INVARIANTS } from "./release-manifest.mjs";
import { verifyLedgerForStage, verifyStageObjects, verifyApprovedInvariants, captureProtectedDigest, requirePinnedStage0Digest, beginReadOnlySnapshot, buildStage4Baseline, validateStage4Baseline, shouldCreateStage4Baseline } from "./release-state.mjs";
import { parseEnv, readGitHead, manifestFingerprint, envProjectRef } from "./release-fs.mjs";

const ANCHOR = 4;
const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..", "..");
const repoRoot = path.resolve(appRoot, "..");
const envPath = path.resolve(repoRoot, ".env.local");
const stage4Path = path.join(here, ".release-baseline-stage4.json");

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
let rolledBack = false;
try {
  await beginReadOnlySnapshot(client); // BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY
  problems.push(...await verifyLedgerForStage(q, ANCHOR));            // migrations 1-4 once each; 5-6 absent
  problems.push(...await verifyApprovedInvariants(q, APPROVED_INVARIANTS)); // rollout/settings/approvals/cron/dfca8f75
  problems.push(...await verifyStageObjects(q, ANCHOR));              // complete CUMULATIVE 1-4 catalog; 5-6 absent
  const digest = await captureProtectedDigest(q);
  console.log(`PROTECTED live=${digest.live_snapshots.c} shadow=${digest.shadow_snapshots.c}`);
  problems.push(...requirePinnedStage0Digest(digest));               // all 8 protected digests == manifest pins
} catch (e) {
  problems.push("query error: " + e.message);
} finally {
  try { await client.query("ROLLBACK"); rolledBack = true; } catch { rolledBack = false; }
  await client.end();
}

if (problems.length) { console.error(`STOP stage-4 re-anchor — ${problems.length} mismatch(es):`); for (const p of problems) console.error("  - " + p); process.exit(1); }
// The baseline is created ONLY after every assertion passed AND the read-only txn rolled back cleanly.
if (!rolledBack) { console.error("STOP read-only transaction did not roll back cleanly; refusing to create the stage-4 baseline"); process.exit(1); }
if (shouldCreateStage4Baseline({ problemCount: problems.length, rolledBack })) {
  const baseline = buildStage4Baseline({ head: currentHead, fingerprint: currentFingerprint }); // manifest-pinned values ONLY
  const self = validateStage4Baseline(baseline, { currentHead, currentFingerprint, envRef, stageIdx: ANCHOR });
  if (self.length) { console.error("STOP built stage-4 baseline fails its own validation:\n  - " + self.join("\n  - ")); process.exit(1); }
  try {
    writeFileSync(stage4Path, JSON.stringify(baseline, null, 2), { flag: "wx" }); // exclusive create; never overwrite
    console.log(`STAGE4-BASELINE created ${path.basename(stage4Path)} (head=${currentHead.slice(0, 12)} fp=${currentFingerprint.slice(0, 12)} anchor=${ANCHOR})`);
  } catch (e) {
    if (e && e.code === "EEXIST") { console.error("STOP stage-4 baseline already exists — refusing to overwrite (remove the reviewed baseline to recreate)"); process.exit(1); }
    console.error("STOP stage-4 baseline write failed: " + e.message); process.exit(1);
  }
}
console.log("RESULT    stage-4 re-anchor OK");
process.exit(0);
