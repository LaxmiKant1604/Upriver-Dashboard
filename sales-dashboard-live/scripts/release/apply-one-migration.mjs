// THROWAWAY single-file migration applier (Scheduler-v2 release).
// Usage:  node scripts/release/apply-one-migration.mjs <one-of-the-six-frozen-filenames.sql>
// EVERY validation (allowlist, frozen SHA-256, PINNED identity, manifest-pinned baseline) completes BEFORE any
// pg.Client is constructed/connected (see runApply). Applies ONE frozen file in ONE advisory-locked
// transaction with stage preconditions, the exact migration manifest, and protected-data immutability.
// Exit codes: 0 committed; 1 rolled back / pre-connect abort; 2 usage; 3 COMMIT_UNKNOWN (ack lost -> operator
// runs ro-prod-check <N+1>; never retry). No DROP/repair.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { NEW6, APPROVED_INVARIANTS } from "./release-manifest.mjs";
import { runApply } from "./release-state.mjs";
import { parseEnv, readGitHead, manifestFingerprint, envProjectRef } from "./release-fs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..", "..");
const repoRoot = path.resolve(appRoot, "..");
const migDir = path.join(appRoot, "supabase", "migrations");
const envPath = path.resolve(repoRoot, ".env.local");
const baselineStage0Path = path.join(here, ".release-baseline.json");
const baselineStage3Path = path.join(here, ".release-baseline-stage3.json");
const baselineStage4Path = path.join(here, ".release-baseline-stage4.json");

const args = process.argv.slice(2);
if (args.length !== 1) { console.error("STOP usage: node scripts/release/apply-one-migration.mjs <one-frozen-filename.sql>"); process.exit(2); }
const FILENAME = args[0];
if (!NEW6.includes(FILENAME) || path.basename(FILENAME) !== FILENAME) { console.error(`STOP ${FILENAME} is not one of the six frozen migrations`); process.exit(1); }
// Baseline by stage: migrations 5-6 -> STAGE-4 re-anchor; migration 4 -> STAGE-3 re-anchor; migrations 1-3 -> stage-0.
const stageIdx = NEW6.indexOf(FILENAME);
const baselinePath = stageIdx >= 4 ? baselineStage4Path : stageIdx === 3 ? baselineStage3Path : baselineStage0Path;

const env = parseEnv(readFileSync(envPath, "utf8"));
const sqlText = readFileSync(path.join(migDir, FILENAME), "utf8");
const actualSha = createHash("sha256").update(sqlText).digest("hex");
const currentHead = readGitHead(path.join(repoRoot, ".git"));
const currentFingerprint = manifestFingerprint(here);
const envRef = envProjectRef(env);
let baselineText;
try { baselineText = readFileSync(baselinePath, "utf8"); }
catch { console.error(`STOP baseline missing (${path.basename(baselinePath)}) — run ${stageIdx >= 4 ? "`node scripts/release/re-anchor-stage4.mjs`" : stageIdx === 3 ? "`node scripts/release/re-anchor-stage3.mjs`" : "`node scripts/release/ro-prod-check.mjs 0`"} first`); process.exit(1); }

const result = await runApply({
  filename: FILENAME, sqlText, actualSha, env, currentHead, currentFingerprint, envRef, baselineText,
  approved: APPROVED_INVARIANTS,
  makeClient: () => { const u = new URL(env.POSTGRES_URL); u.searchParams.set("sslmode", "no-verify"); return new pg.Client({ connectionString: u.toString() }); },
});

// result.message already carries its disposition label (COMMITTED / ROLLBACK / COMMIT_UNKNOWN); print once.
if (result.code === 0) console.log(result.message);
else console.error(result.message);
process.exit(result.code);
