// THROWAWAY DEDICATED stage-3 re-anchor (Scheduler-v2 release; forward-only recovery from an APPLIED stage 3).
// Usage:  node scripts/release/re-anchor-stage3.mjs   (run from sales-dashboard-live/)
//
// This is NOT a generic "baseline at any stage": the anchor is HARD-CODED to 3. It is strictly READ-ONLY --
// validates the pinned approved identity BEFORE connecting; reads under BEGIN ISOLATION LEVEL REPEATABLE READ
// READ ONLY; requires the EXACT stage-3 production state (ledger = base + migrations 1-3 once each AND 4-6
// absent; the COMPLETE catalog for migrations 1-3; migrations 4-6 objects absent; all EIGHT protected digests
// EQUAL the existing manifest pins exactly; rollout/settings/approvals/cron/dfca8f75 invariants exactly); ALWAYS
// ROLLBACK; then creates a SEPARATE stage-3 baseline file (.release-baseline-stage3.json) with exclusive/
// no-overwrite semantics, bound to the final HEAD, the corrected manifest fingerprint, all six frozen migration
// hashes, the approved project identity and anchorStage=3. The stage-0 baseline is left UNTOUCHED for audit.
// It NEVER captures arbitrary current state as authority (the pinned digests + invariants are the authority).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { validateIdentity, APPROVED_INVARIANTS } from "./release-manifest.mjs";
import { verifyLedgerForStage, verifyStageObjects, verifyApprovedInvariants, captureProtectedDigest, requirePinnedStage0Digest, beginReadOnlySnapshot, buildStage3Baseline, validateStage3Baseline, shouldCreateStage3Baseline } from "./release-state.mjs";
import { parseEnv, readGitHead, manifestFingerprint, envProjectRef } from "./release-fs.mjs";

const ANCHOR = 3;
const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..", "..");
const repoRoot = path.resolve(appRoot, "..");
const envPath = path.resolve(repoRoot, ".env.local");
const stage3Path = path.join(here, ".release-baseline-stage3.json");

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
  problems.push(...await verifyLedgerForStage(q, ANCHOR));            // migrations 1-3 once each; 4-6 absent
  problems.push(...await verifyApprovedInvariants(q, APPROVED_INVARIANTS)); // rollout/settings/approvals/cron/dfca8f75
  problems.push(...await verifyStageObjects(q, ANCHOR));              // complete 1-3 catalog; 4-6 objects absent
  const digest = await captureProtectedDigest(q);
  console.log(`PROTECTED live=${digest.live_snapshots.c} shadow=${digest.shadow_snapshots.c}`);
  problems.push(...requirePinnedStage0Digest(digest));               // all 8 protected digests == manifest pins
} catch (e) {
  problems.push("query error: " + e.message);
} finally {
  try { await client.query("ROLLBACK"); rolledBack = true; } catch { rolledBack = false; }
  await client.end();
}

if (problems.length) { console.error(`STOP stage-3 re-anchor — ${problems.length} mismatch(es):`); for (const p of problems) console.error("  - " + p); process.exit(1); }
// The baseline is created ONLY after every assertion passed AND the read-only txn rolled back cleanly.
if (!rolledBack) { console.error("STOP read-only transaction did not roll back cleanly; refusing to create the stage-3 baseline"); process.exit(1); }
if (shouldCreateStage3Baseline({ problemCount: problems.length, rolledBack })) {
  const baseline = buildStage3Baseline({ head: currentHead, fingerprint: currentFingerprint }); // manifest-pinned values ONLY
  // Self-check: the built baseline must validate against the exact state we just proved (anchorStage 3).
  const self = validateStage3Baseline(baseline, { currentHead, currentFingerprint, envRef, stageIdx: ANCHOR });
  if (self.length) { console.error("STOP built stage-3 baseline fails its own validation:\n  - " + self.join("\n  - ")); process.exit(1); }
  try {
    writeFileSync(stage3Path, JSON.stringify(baseline, null, 2), { flag: "wx" }); // exclusive create; never overwrite
    console.log(`STAGE3-BASELINE created ${path.basename(stage3Path)} (head=${currentHead.slice(0, 12)} fp=${currentFingerprint.slice(0, 12)} anchor=${ANCHOR})`);
  } catch (e) {
    if (e && e.code === "EEXIST") { console.error("STOP stage-3 baseline already exists — refusing to overwrite (remove the reviewed baseline to recreate)"); process.exit(1); }
    console.error("STOP stage-3 baseline write failed: " + e.message); process.exit(1);
  }
}
console.log("RESULT    stage-3 re-anchor OK");
process.exit(0);
