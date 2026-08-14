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
  "test:insights",
  "test:brand-view",
  "test:sync",
  "test:source-cache",
  "test:sync-engine",
  "test:report-derivation",
  "test:source-identity",
  "test:report-contracts",
  "test:report-sync-controls",
  "test:gate5-canary-package",
  "test:datadoe-poll-export",
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
