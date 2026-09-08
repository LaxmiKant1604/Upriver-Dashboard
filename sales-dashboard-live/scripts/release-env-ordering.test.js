// Release-env import-ordering + fail-closed-config offline verification.
//
// The observed production defect: the India natural run completed OLI refresh, Campaign Ads refresh and D-1
// readiness, then failed at "Open publication controls" with
//   "buildPriorityControlPackage requires >=1 primary account (fail closed)."
// ROOT CAUSE: scripts/release/priority-control-package.mjs STATICALLY imported priority-control-pg-store.js,
// which imports lib/server/supabase.js. supabase.js captures SUPABASE_URL + SUPABASE_SECRET_KEY into MODULE-LEVEL
// constants the instant it is imported. Static ESM imports are HOISTED and fully evaluated BEFORE the file's own
// top-level code (including loadReleaseEnv()), so the Supabase credentials were captured while process.env was
// still empty -- every discovery read failed and was (wrongly) surfaced as "0 primary accounts".
//
// This suite proves the permanent fix, offline, with ZERO DataDoe/network/DB:
//   A. bootstrap maps SUPABASE_URL from VITE_SUPABASE_URL, and it does so BEFORE supabase.js captures creds
//      (a real 2-child-process ordering experiment, plus the pure applyEnv contract).
//   B. NO env-at-eval lib/server module is reachable via a STATIC import in ANY scheduler-owned release
//      entrypoint that relies on loadReleaseEnv() (a source guard) -- and the guard actually detects the defect.
//   C. Production-shaped priority discovery (8 india / 30 europe-au / 11 us-ca) flows through the REAL
//      composition to non-zero account sets, never collapsing to zero.
//   D. Missing URL/key returns a TYPED RELEASE_CONFIG_UNAVAILABLE failure, and the entrypoint calls that gate
//      BEFORE any env-dependent import / discovery / store connection / publication.
//   E. The priority dry-run performs ZERO writes and builds exactly 24 India approvals.
//   F. The REAL priority-control composition is exercised (runControlPackageCli + buildPriorityControlPackage
//      from the shipped lib), not a copied model or a static assertion alone.
//   G. FBA overflow is UNCHANGED: the normal India inventory plan is [5,3]; with the whale batch truncated it
//      splits to [5,1,1,1] (exactly 3 single-seller recovery exports => 15-token premium ceiling).
//
// 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync, existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { applyEnv, parseEnvFile, assertSupabaseReleaseConfig, loadReleaseEnv } from "./release/env-bootstrap.mjs";
import { runControlPackageCli, buildPriorityControlPackage, PRIORITY_DISPATCH_ENABLED, PRIORITY_PROMOTED_ENABLED } from "../lib/server/sync/source-priority-control-package.js";
import { CONTROLLED_REPORT_KEYS } from "../lib/server/sync/report-controls.js";
import { planFbaPlanBucketBatched } from "../lib/server/sync/report-planner.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "release-env-ordering\n");

const HERE = dirname(fileURLToPath(import.meta.url));       // <app>/scripts
const APP_ROOT = resolve(HERE, "..");                       // <app>
const RELEASE_DIR = resolve(APP_ROOT, "scripts", "release");
const SUPABASE_ABS = resolve(APP_ROOT, "lib", "server", "supabase.js");
const ENTRYPOINT_ABS = resolve(RELEASE_DIR, "priority-control-package.mjs");

/* ============================================================================================================
 * Shared source-scanning helpers (used by the B source guard).
 * ============================================================================================================ */

// A lib/server module is "env-at-eval" (unsafe to STATIC-import before loadReleaseEnv) when it reads process.env
// at MODULE-EVALUATION time: a top-level (column 0), non-comment statement that reads process.env and is NOT a
// function/arrow declaration (a default-parameter `= process.env` or an arrow body is LAZY -- evaluated per call,
// not at import). Matches supabase.js `const SUPABASE_URL = String(process.env...)`; skips env-bootstrap's
// `export function applyEnv({ env = process.env })` and datadoe-connections' inside-function (indented) reads.
function isEnvAtEvalLine(line) {
  if (/^\s/.test(line)) return false;                        // indented => inside a block/function => lazy
  if (!/\bprocess\.env\b/.test(line)) return false;
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false; // comment
  if (/\bfunction\b/.test(t) || /=>/.test(t)) return false;  // function decl / arrow default-param => lazy
  return true;
}
function readsEnvAtEval(absPath) {
  if (!existsSync(absPath)) return false;
  return readFileSync(absPath, "utf8").split(/\r?\n/).some(isEnvAtEvalLine);
}

// Extract the specifiers of STATIC imports only (import ... from "x" AND side-effect import "x"). Deliberately
// does NOT match dynamic `await import("x")` (no `from`, and not at statement start) -- those run at call time,
// after loadReleaseEnv(), so they are the SAFE pattern.
function staticImportSpecifiers(text) {
  const specs = [];
  const fromRe = /(?:^|[\n;])\s*import\s+[^;]*?\bfrom\s*['"]([^'"]+)['"]/g;
  const sideRe = /(?:^|[\n;])\s*import\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = fromRe.exec(text))) specs.push(m[1]);
  while ((m = sideRe.exec(text))) specs.push(m[1]);
  return specs;
}
// Resolve a relative specifier from a file's own directory to an existing .js path; null for node:/bare/npm.
function resolveLocal(fromDir, spec) {
  if (!spec.startsWith(".")) return null;                    // node:* or npm package -> not our source graph
  let p = resolve(fromDir, spec);
  if (!existsSync(p) && existsSync(p + ".js")) p = p + ".js";
  return existsSync(p) ? p : null;
}
// BFS the transitive STATIC-import graph starting from a set of local files; return every env-at-eval module
// reachable (deduped, app-root-relative for readable assertions).
function reachableEnvAtEval(startAbsPaths) {
  const seen = new Set();
  const queue = [...startAbsPaths];
  const hits = new Set();
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    if (!existsSync(cur)) continue;
    if (readsEnvAtEval(cur)) hits.add(cur.slice(APP_ROOT.length + 1).replace(/\\/g, "/"));
    for (const spec of staticImportSpecifiers(readFileSync(cur, "utf8"))) {
      const abs = resolveLocal(dirname(cur), spec);
      if (abs && !seen.has(abs)) queue.push(abs);
    }
  }
  return [...hits].sort();
}
// For an entrypoint file: the env-at-eval modules reachable through its STATIC imports (the ones that would
// evaluate before loadReleaseEnv()). Only meaningful for entrypoints that CALL loadReleaseEnv().
function entrypointStaticEnvReach(entryText, entryDir) {
  const starts = [];
  for (const spec of staticImportSpecifiers(entryText)) {
    const abs = resolveLocal(entryDir, spec);
    if (abs) starts.push(abs);
  }
  return reachableEnvAtEval(starts);
}
const callsLoadReleaseEnv = (text) => /\bloadReleaseEnv\s*\(/.test(text);

/* ============================================================================================================
 * A. bootstrap maps SUPABASE_URL from VITE_SUPABASE_URL -- pure contract + a REAL ordering experiment.
 * ============================================================================================================ */
(() => {
  // Pure: VITE_SUPABASE_URL fills an unset SUPABASE_URL (and reports it), never overriding a set one (CI wins).
  const e1 = { VITE_SUPABASE_URL: "https://proj.supabase.co" };
  const r1 = applyEnv({ env: e1 });
  ok("A: applyEnv maps SUPABASE_URL from VITE_SUPABASE_URL when unset", e1.SUPABASE_URL === "https://proj.supabase.co" && r1.mappedSupabaseUrl === true);
  const e2 = { SUPABASE_URL: "https://ci.example", VITE_SUPABASE_URL: "https://proj.supabase.co" };
  const r2 = applyEnv({ env: e2 });
  ok("A: applyEnv never overrides an already-set SUPABASE_URL (CI secret wins)", e2.SUPABASE_URL === "https://ci.example" && r2.mappedSupabaseUrl === false);
  // File seam: a present .env.local fills only UNSET keys; parseEnvFile strips quotes.
  const parsed = parseEnvFile('A=1\nB="two"\n# c\nVITE_SUPABASE_URL=https://file.supabase.co\n');
  ok("A: parseEnvFile parses/uncomments/strips-quotes", parsed.A === "1" && parsed.B === "two" && parsed.VITE_SUPABASE_URL === "https://file.supabase.co" && !("c" in parsed));
  const eFile = { SUPABASE_SERVICE_ROLE_KEY: "ci-key" };
  const rFile = applyEnv({ envFilePath: "/fake/.env.local", env: eFile, exists: () => true, read: () => "VITE_SUPABASE_URL=https://file.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=file-key\n" });
  ok("A: env file fills unset keys + maps SUPABASE_URL; set key untouched", eFile.SUPABASE_URL === "https://file.supabase.co" && eFile.SUPABASE_SERVICE_ROLE_KEY === "ci-key" && rFile.loadedEnvFile === true && rFile.mappedSupabaseUrl === true);
})();

// REAL ordering experiment: two child processes with ONLY VITE_SUPABASE_URL (+ a service key) set, SUPABASE_URL
// deliberately UNSET. "after" maps env BEFORE importing supabase.js -> configured. "before" imports supabase.js
// FIRST -> creds captured blank -> unconfigured. This is the concrete proof that the mapping must precede the
// module evaluation, and that the fix's dynamic-import-after-loadReleaseEnv ordering is what makes discovery work.
(() => {
  const tmp = mkdtempSync(join(tmpdir(), "relenv-"));
  const childPath = join(tmp, "ordering-child.mjs");
  const bootUrl = pathToFileURL(resolve(RELEASE_DIR, "env-bootstrap.mjs")).href;
  const supaUrl = pathToFileURL(SUPABASE_ABS).href;
  const child = [
    `import { applyEnv } from ${JSON.stringify(bootUrl)};`,
    `const supa = ${JSON.stringify(supaUrl)};`,
    `if (process.env.__MODE === "after") {`,
    `  applyEnv({ env: process.env });`,
    `  const m = await import(supa);`,
    `  process.stdout.write(m.isSupabaseConfigured() ? "CONFIGURED" : "UNCONFIGURED");`,
    `} else {`,
    `  const m = await import(supa);`,
    `  applyEnv({ env: process.env });`,
    `  process.stdout.write(m.isSupabaseConfigured() ? "CONFIGURED" : "UNCONFIGURED");`,
    `}`,
  ].join("\n");
  writeFileSync(childPath, child, "utf8");
  // Inherit the real env (so node has PATH/SystemRoot) but STRIP every Supabase var, then inject the controlled
  // VITE url + a service key. Guarantees SUPABASE_URL is unset going in.
  const baseEnv = { ...process.env };
  delete baseEnv.SUPABASE_URL; delete baseEnv.SUPABASE_SECRET_KEY; delete baseEnv.SUPABASE_SERVICE_ROLE_KEY;
  const mk = (mode) => spawnSync(process.execPath, [childPath], {
    encoding: "utf8",
    env: { ...baseEnv, __MODE: mode, VITE_SUPABASE_URL: "https://ordering-proof.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc-key-ordering" },
  });
  try {
    const after = mk("after");
    const before = mk("before");
    ok("A: mapping BEFORE supabase.js evaluates => isSupabaseConfigured() true (child, only VITE set)", after.status === 0 && after.stdout.trim() === "CONFIGURED");
    ok("A: importing supabase.js BEFORE the mapping => unconfigured (proves ordering is load-bearing)", before.status === 0 && before.stdout.trim() === "UNCONFIGURED");
  } finally {
    try { unlinkSync(childPath); } catch { /* ignore */ }
    try { rmdirSync(tmp); } catch { /* ignore */ }
  }
})();

/* ============================================================================================================
 * B. SOURCE GUARD -- no env-at-eval lib/server module reachable via STATIC imports before loadReleaseEnv().
 * ============================================================================================================ */
(() => {
  // Self-check: the guard's env-at-eval detector correctly classifies the known modules.
  ok("B: detector flags supabase.js (module-level process.env capture)", readsEnvAtEval(SUPABASE_ABS) === true);
  ok("B: detector does NOT flag env-bootstrap.mjs (process.env only as a function default param)", readsEnvAtEval(resolve(RELEASE_DIR, "env-bootstrap.mjs")) === false);
  const dataDoeConn = resolve(APP_ROOT, "lib", "server", "datadoe-connections.js");
  ok("B: detector does NOT flag datadoe-connections.js (env read lazily inside functions)", readsEnvAtEval(dataDoeConn) === false);

  // POSITIVE CONTROL: a synthetic entrypoint that STATIC-imports the pg store IS flagged (reaches supabase.js).
  // Proves the guard actually detects the defect class rather than passing vacuously.
  const badReach = entrypointStaticEnvReach(
    'import { loadReleaseEnv } from "./env-bootstrap.mjs";\nimport { discoverPrimaryAccountIds } from "../../lib/server/sync/priority-control-pg-store.js";\nloadReleaseEnv();\n',
    RELEASE_DIR,
  );
  ok("B: guard DETECTS the defect -- a static pg-store import reaches supabase.js", badReach.includes("lib/server/supabase.js"));

  // The FIXED entrypoint: zero env-at-eval modules reachable via its static imports.
  const entryText = readFileSync(ENTRYPOINT_ABS, "utf8");
  const fixedReach = entrypointStaticEnvReach(entryText, RELEASE_DIR);
  ok("B: priority-control-package.mjs reaches NO env-at-eval module via static imports", fixedReach.length === 0);

  // The required entrypoint list must all exist and, if they call loadReleaseEnv, be clean too.
  const REQUIRED = [
    "priority-control-package.mjs", "priority-dashboards-release.mjs", "bootstrap-publish.mjs", "fba-plan-golive.mjs",
    "oli-refresh-d1.mjs", "scheduled-campaign-ads-refresh.mjs", "scheduled-cycle-preflight.mjs", "verify-bucket-readiness.mjs",
    "verify-us-d1-published.mjs", "regional-scheduler-dry-run.mjs", "verify-bootstrap-published.mjs",
  ];
  const missing = REQUIRED.filter((f) => !existsSync(resolve(RELEASE_DIR, f)));
  ok("B: every required release entrypoint exists", missing.length === 0);

  // FULL SWEEP: every scheduler-owned .mjs in scripts/release that CALLS loadReleaseEnv() must have a clean
  // static-import graph. Fails CLOSED, naming the offending (entrypoint -> env-at-eval module) pairs.
  const offenders = [];
  let scanned = 0;
  for (const f of readdirSync(RELEASE_DIR)) {
    if (!f.endsWith(".mjs")) continue;
    const abs = resolve(RELEASE_DIR, f);
    const text = readFileSync(abs, "utf8");
    if (!callsLoadReleaseEnv(text)) continue;
    scanned += 1;
    const reach = entrypointStaticEnvReach(text, RELEASE_DIR);
    if (reach.length) offenders.push(f + " -> " + reach.join(","));
  }
  ok("B: swept a meaningful number of loadReleaseEnv() entrypoints (>= required list)", scanned >= REQUIRED.length);
  ok("B: NO scheduler-owned release entrypoint statically reaches an env-at-eval module" + (offenders.length ? " [" + offenders.join(" | ") + "]" : ""), offenders.length === 0);
})();

/* ============================================================================================================
 * C + E + F. REAL composition: production-shaped discovery -> non-zero packages; dry-run writes nothing.
 * ============================================================================================================ */
await (async () => {
  // F: use the SHIPPED composition (imported above), not a copy. Confirm its publish-key surface is the real one.
  ok("F: real PRIORITY_DISPATCH_ENABLED is [daily-reporting, brand-sales]", PRIORITY_DISPATCH_ENABLED.join(",") === "daily-reporting,brand-sales");
  ok("F: real PRIORITY_PROMOTED_ENABLED is brand-inventory", PRIORITY_PROMOTED_ENABLED === "brand-inventory");
  ok("F: buildPriorityControlPackage is the shipped function", typeof buildPriorityControlPackage === "function" && typeof runControlPackageCli === "function");

  const shaped = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}-acct-${String(i + 1).padStart(2, "0")}`);
  const REGIONS = [{ bucket: "india", n: 8, approvals: 24 }, { bucket: "europe-au", n: 30, approvals: 90 }, { bucket: "us-ca", n: 11, approvals: 33 }];
  for (const r of REGIONS) {
    let connectCalls = 0;
    const connectStore = async () => { connectCalls += 1; throw new Error("connectStore MUST NOT be called during a dry-run"); };
    const res = await runControlPackageCli({
      mode: "dry-run",
      operator: "laxmikant@superboring.in",
      discoverAccounts: async () => shaped(r.bucket, r.n),
      connectStore,
      controlledReportKeys: CONTROLLED_REPORT_KEYS,
    });
    // C: counts flow through the REAL composition to a non-zero package -- never collapse to zero / fail-closed.
    ok(`C: ${r.bucket} production-shaped discovery -> ${r.n} accounts (not zero)`, res.dryRun === true && res.pkg.accounts.length === r.n && res.pkg.post.rolloutEnabled.length === r.n);
    ok(`C/E: ${r.bucket} -> ${r.approvals} approvals via real composition (${r.n} x 3 publish keys)`, res.pkg.post.approvals.length === r.approvals && res.pkg.apply.approvals.length === r.approvals);
    // E: a dry-run performs ZERO writes -- it returns before any store connection.
    ok(`E: ${r.bucket} dry-run connected NO store (zero writes)`, connectCalls === 0 && res.committed === false && res.code === 0);
  }

  // E (India headline): exactly 24 approvals + all_primary stays false + no cron.
  const india = buildPriorityControlPackage({ accounts: shaped("india", 8), operator: "laxmikant@superboring.in", controlledReportKeys: CONTROLLED_REPORT_KEYS });
  ok("E: India builds exactly 24 approvals, all_primary=false, noCron", india.post.approvals.length === 24 && india.apply.allPrimary === false && india.post.noCron === true);
  // The fail-closed error the production defect surfaced is REAL and still guards an empty set.
  assert.throws(() => buildPriorityControlPackage({ accounts: [], operator: "x" }), /requires >=1 primary account/);
  ok("C: the empty-set fail-closed still throws (a REAL empty set), so 'not zero' is meaningful", true);
})();

/* ============================================================================================================
 * D. Typed RELEASE_CONFIG_UNAVAILABLE fail-closed + entrypoint calls it before any env-dependent work.
 * ============================================================================================================ */
(() => {
  const throwsTyped = (env) => {
    try { assertSupabaseReleaseConfig(env); return null; }
    catch (e) { return e; }
  };
  const eNoUrl = throwsTyped({ SUPABASE_SERVICE_ROLE_KEY: "k" });
  ok("D: missing URL -> typed RELEASE_CONFIG_UNAVAILABLE", eNoUrl && eNoUrl.code === "RELEASE_CONFIG_UNAVAILABLE" && /SUPABASE_URL/.test(eNoUrl.message));
  const eNoKey = throwsTyped({ SUPABASE_URL: "https://x" });
  ok("D: missing key -> typed RELEASE_CONFIG_UNAVAILABLE", eNoKey && eNoKey.code === "RELEASE_CONFIG_UNAVAILABLE" && /SERVICE_ROLE_KEY|SECRET_KEY/.test(eNoKey.message));
  // Honest typing: a typed code + an explicit "CONFIGURATION failure" label, so callers can distinguish this
  // from an empty discovery result and NEVER degrade it into "zero accounts" (the message names that phrase only
  // to explicitly disclaim it).
  ok("D: the error is TYPED + explicitly a configuration failure (not a degraded empty result)", eNoUrl && eNoUrl.code === "RELEASE_CONFIG_UNAVAILABLE" && /CONFIGURATION failure/.test(eNoUrl.message) && /it is NOT/.test(eNoUrl.message));
  ok("D: VITE_SUPABASE_URL alone satisfies the URL half", throwsTyped({ VITE_SUPABASE_URL: "https://x", SUPABASE_SECRET_KEY: "k" }) === null);
  ok("D: both present (SERVICE_ROLE_KEY) -> passes", assertSupabaseReleaseConfig({ SUPABASE_URL: "https://x", SUPABASE_SERVICE_ROLE_KEY: "k" }) === true);
  ok("D: both present (SECRET_KEY) -> passes", assertSupabaseReleaseConfig({ SUPABASE_URL: "https://x", SUPABASE_SECRET_KEY: "k" }) === true);

  // STRUCTURAL order in the entrypoint: assertSupabaseReleaseConfig() runs AFTER loadReleaseEnv() and BEFORE the
  // first env-dependent dynamic import, discovery call, and store connection -- so config failure precedes any
  // DataDoe/DB/lease/controls/publication work.
  const src = readFileSync(ENTRYPOINT_ABS, "utf8");
  const posLoad = src.indexOf("loadReleaseEnv(");
  const posAssert = src.indexOf("assertSupabaseReleaseConfig(");
  const posFirstDynImport = src.indexOf("await import(");
  const posDiscover = src.indexOf("discoverPrimaryAccountIds");
  const posConnect = src.indexOf("connectPriorityControlStore");
  ok("D: entrypoint calls loadReleaseEnv() then assertSupabaseReleaseConfig()", posLoad >= 0 && posAssert > posLoad);
  ok("D: entrypoint asserts config BEFORE the first env-dependent dynamic import", posFirstDynImport > posAssert);
  ok("D: entrypoint asserts config BEFORE any discovery / store reference", posDiscover > posAssert && posConnect > posAssert);
  // The only STATIC lib import in the entrypoint is env-bootstrap (everything env-dependent is dynamic).
  const staticSpecs = staticImportSpecifiers(src);
  const nonBootstrapStatic = staticSpecs.filter((s) => !s.startsWith("node:") && s !== "./env-bootstrap.mjs");
  ok("D/B: entrypoint's ONLY static imports are env-bootstrap + node builtins", nonBootstrapStatic.length === 0);
})();

/* ============================================================================================================
 * G. FBA overflow UNCHANGED: normal India inventory [5,3]; whale-batch truncation -> [5,1,1,1] (3 x premium).
 * ============================================================================================================ */
(() => {
  const conns = [{ id: "primary", apiKey: "fixture-key", accountPrefix: "" }];
  const asOf = "2026-09-08";
  const IN8 = Array.from({ length: 8 }, (_, i) => ({ accountId: `in-${i}`, country: "IN", currency: "INR" }));
  const invOf = (plan) => [...new Map(plan.flatMap((r) => r.sources.filter((s) => s.requestKey === "fba-plan:inventory-health").map((s) => [s.requestHash, s]))).values()];

  const baseInv = invOf(planFbaPlanBucketBatched({ accounts: IN8, connections: conns, asOfFor: () => asOf, inventoryAsOf: asOf }));
  const baseSizes = baseInv.map((s) => s.sellerOrVendorIds.length).sort((a, b) => a - b).join(",");
  ok("G: normal India inventory plan is [5,3] (unchanged default batching)", baseSizes === "3,5");

  const whale = baseInv.find((s) => s.sellerOrVendorIds.length === 3).sellerOrVendorIds.map(String);
  const splitInv = invOf(planFbaPlanBucketBatched({ accounts: IN8, connections: conns, asOfFor: () => asOf, inventoryAsOf: asOf, overflowSellers: new Set(whale) }));
  const splitSizes = splitInv.map((s) => s.sellerOrVendorIds.length).sort((a, b) => a - b).join(",");
  ok("G: whale-batch truncation splits India inventory to [5,1,1,1]", splitSizes === "1,1,1,5");

  const singles = splitInv.filter((s) => s.sellerOrVendorIds.length === 1);
  ok("G: exactly 3 single-seller recovery exports (the isolated whales)", singles.length === 3);
  ok("G: each recovery child is a strict 50000-capped inventory export", singles.every((s) => s.strict === true && s.limit === 50000));
  const PREMIUM_TOKENS = 5; // DataDoe premium (inventory) export = 5 tokens/create
  ok("G: dedicated recovery token ceiling is exactly 15 (3 single-seller premium creates)", singles.length * PREMIUM_TOKENS === 15);
  // An empty overflow set is byte-identical to the default (no accidental split).
  const noneInv = invOf(planFbaPlanBucketBatched({ accounts: IN8, connections: conns, asOfFor: () => asOf, inventoryAsOf: asOf, overflowSellers: new Set() }));
  ok("G: empty overflow set == default plan (byte-identical hashes)", new Set(noneInv.map((s) => s.requestHash)).size === new Set(baseInv.map((s) => s.requestHash)).size && noneInv.every((s) => baseInv.some((b) => b.requestHash === s.requestHash)));
})();

writeSync(1, `\nrelease-env-ordering: ${passed} assertions passed\n`);
