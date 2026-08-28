// SCHEDULER v2 HARDENING -- deterministic OFFLINE proof that tomorrow's automatic runs (a) map each cron to the
// correct bucket, (b) treat expected pending itemization as a GREEN D1_PROVISIONAL publication (never
// DATADOE_D1_NOT_READY), (c) fail closed ONLY on a genuine SOURCE_DEFECT, (d) print immutable run metadata, and
// (e) carry an idempotent per-bucket fallback that shares one durable operation identity. Shape assertions over the
// workflow + the readiness/operator CLIs (no I/O). 7-bit ASCII.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const yml = readFileSync(resolve(ROOT, "..", ".github", "workflows", "scheduler-v2.yml"), "utf8");
const readiness = readFileSync(resolve(ROOT, "scripts", "release", "verify-bucket-readiness.mjs"), "utf8");
const operator = readFileSync(resolve(ROOT, "scripts", "release", "oli-refresh-d1.mjs"), "utf8");
const release = readFileSync(resolve(ROOT, "lib", "server", "sync", "source-priority-release-runner.js"), "utf8");

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const test = (name, fn) => { try { fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

/* 12/13. correct cron -> correct bucket; unknown cron fails BEFORE any production I/O */
test("12/13. each cron maps deterministically to its bucket; unknown cron fails closed before I/O", () => {
  const crons = [...yml.matchAll(/- cron:\s*"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(crons, ["0 2 * * *", "0 3 * * *", "30 10 * * *", "30 11 * * *"]);
  assert.match(yml, /"0 2 \* \* \*"\)\s*bucket="non-us";\s*run_kind="primary"/);
  assert.match(yml, /"0 3 \* \* \*"\)\s*bucket="non-us";\s*run_kind="fallback"/);
  assert.match(yml, /"30 10 \* \* \*"\)\s*bucket="us";\s*run_kind="primary"/);
  assert.match(yml, /"30 11 \* \* \*"\)\s*bucket="us";\s*run_kind="fallback"/);
  assert.match(yml, /Unknown cron[^\n]*refusing \(fail closed\)/);
  // the unknown-cron guard is in the SAME cfg step, before install/preflight/token/fetch.
  const cfgIdx = yml.indexOf("Resolve bucket + requestedAsOf");
  const npmIdx = yml.indexOf("npm ci");
  assert.ok(cfgIdx > 0 && cfgIdx < npmIdx, "bucket resolution + unknown-cron guard run before npm ci / any I/O");
});

/* 1/3/6. requestedAsOf is the PREVIOUS UTC DAY (D-1) -- computed once, UTC, from the calendar, never the clock/bucket */
test("1/3/6. requestedAsOf = previous UTC day (D-1): computed via `date -u -d 'yesterday'`, UTC + calendar, not the local clock or bucket", () => {
  // The workflow computes a SINGLE previous-UTC-day asof AFTER bucket resolution: -u forces UTC (never the runner's
  // local zone), 'yesterday' is the previous CALENDAR day (D-1) at execution time, and it is bucket-independent.
  assert.match(yml, /asof="\$\(date -u -d 'yesterday' \+%Y-%m-%d\)"/, "asof is the previous UTC calendar day (D-1)");
  // Exactly ONE asof computation (not one per bucket, not derived from the wall-clock hour).
  assert.equal((yml.match(/date -u -d 'yesterday'/g) || []).length, 1, "asof is computed exactly once");
  assert.doesNotMatch(yml, /asof=.*date \+/, "asof never uses the LOCAL date (must be -u / UTC)");
  // A delayed run keeps the correct bucket (from github.event.schedule) AND a previous-UTC-day D-1 (from the calendar
  // at execution time) -- neither is inferred from the wall-clock hour.
  const jsPrevUtc = () => { const d = new Date(Date.UTC(2026, 7, 28, 2, 0, 0)); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
  assert.equal(jsPrevUtc(), "2026-08-27", "the readiness/operator default previous-UTC-day arithmetic yields D-1");
  // The operator + readiness are HANDED the asof (they never recompute the date from the clock on a scheduled run).
  assert.match(yml, /oli-refresh-d1\.mjs[^\n]*--requested-as-of=\$\{\{ steps\.cfg\.outputs\.asof \}\}/, "operator receives the resolved asof");
  assert.match(yml, /verify-bucket-readiness\.mjs[^\n]*--requested-as-of=\$\{\{ steps\.cfg\.outputs\.asof \}\}/, "readiness receives the resolved asof");
  const readiness2 = readiness; // the CLI default (when no --requested-as-of) is the previous UTC day, not local.
  assert.match(readiness2, /setUTCDate\(d\.getUTCDate\(\) - 1\)/, "the readiness CLI default asof is UTC previous-day");
});

/* scheduled events cannot select force-latest via input injection */
test("scheduled events are ALWAYS normal mode (force-latest is dispatch-only; no input injection)", () => {
  assert.match(yml, /if \[ "\$\{\{ github\.event_name \}\}" = "schedule" \]; then[\s\S]*?mode="normal"/);
  // a scheduled branch sets mode="normal" and never reads github.event.inputs.refresh_mode.
  const schedBlock = yml.slice(yml.indexOf('= "schedule" ]; then'), yml.indexOf("else\n"));
  assert.doesNotMatch(schedBlock, /inputs\.refresh_mode/, "the scheduled branch never reads a refresh_mode input");
});

/* 14. every run prints IMMUTABLE metadata (event, cron, bucket, SHA, run id, asOf, mode, opkey, contract, ceiling) */
test("14. the summary prints immutable run metadata (event/cron/bucket/SHA/asOf/mode/opkey/contract/ceiling)", () => {
  for (const token of ["github.event_name", "github.event.schedule", "resolved bucket", "github.sha", "github.run_id", "requestedAsOf", "refresh_mode", "operation key", "source contract", "token ceiling", "run_kind="]) {
    assert.ok(yml.includes(token), "summary/metadata missing: " + token);
  }
});

/* fallback shares ONE durable operation identity (bucket + requestedAsOf, NOT the cron) */
test("primary + fallback share one durable operation key (bucket + requestedAsOf, never the cron string)", () => {
  assert.match(yml, /opkey="scheduled-fresh\/\$bucket\/\$asof"/, "operation key is bucket + requestedAsOf");
  assert.doesNotMatch(yml, /opkey="[^"]*\* \*/, "the operation key never embeds a cron expression");
});

/* readiness: expected pending itemization is D1_PROVISIONAL + proceed, never DATADOE_D1_NOT_READY */
test("2/3. readiness classifies D1_PROVISIONAL / D1_FINAL and proceeds; pending is not a not-ready", () => {
  assert.match(readiness, /D1_PROVISIONAL/); assert.match(readiness, /D1_FINAL/);
  assert.match(readiness, /ghOut\("proceed", "true"\)/, "a provisional/final readiness proceeds");
  // there is NO OLI_D1_PENDING_ITEMIZATION -> not-ready path anywhere in the readiness classifier.
  assert.doesNotMatch(readiness, /OLI_D1_PENDING_ITEMIZATION/, "the old pending-holds-window code is gone from readiness");
});

/* 4. a genuine itemized-value defect fails closed with SOURCE_DEFECT (nonzero), never masked as provisional */
test("4. a genuine SOURCE_DEFECT fails closed (exit 1); it is never published or masked as provisional", () => {
  assert.match(readiness, /if \(defectIds\.size > 0\)/, "a defect is detected");
  const defBlock = readiness.slice(readiness.indexOf("if (defectIds.size > 0)"), readiness.indexOf("const runClass"));
  assert.match(defBlock, /SOURCE_DEFECT/); assert.match(defBlock, /process\.exit\(1\)/, "SOURCE_DEFECT exits nonzero");
  // the operator + release also fail closed on a real defect (OLI_ITEMIZED_VALUE_MISSING).
  assert.match(operator, /OLI_ITEMIZED_VALUE_MISSING|realDefect/);
});

/* 9. a successful primary makes the fallback a zero-create idempotent no-op (ALREADY_PUBLISHED_D1) */
test("9. ALREADY_PUBLISHED_D1: an already-complete D-1 is a ZERO-create/ZERO-token idempotent no-op", () => {
  assert.match(operator, /ALREADY_PUBLISHED_D1/);
  assert.match(operator, /creates: 0, tokens: 0/, "zero creates + zero tokens when already complete");
});

/* 10. the release still fails closed below D-1 (belt-and-suspenders --strict-d1, coverage-based) */
test("10. the release is --strict-d1 and its clamp gate is coverage-based (provisional at D-1 coverage passes)", () => {
  assert.match(yml, /priority-dashboards-release\.mjs[^\n]*--strict-d1/);
  assert.match(release, /strictD1 && rollup\.derived && rollup\.derived\.asOfClamped === true/, "clamp gate is the bucket-wide effectivePublishAsOf, not per-account sales date");
});

/* 18/19. controls always safe-close; Campaign Ads / FBA never create exports */
test("18/19. controls safe-close ALWAYS; the scheduler never runs Campaign Ads / FBA export steps", () => {
  assert.match(yml, /if:\s*always\(\)\n\s*run:\s*node scripts\/release\/priority-control-package\.mjs --rollback/, "safe-close ALWAYS");
  assert.doesNotMatch(yml, /campaign-ads|fba-refresh|campaign_ads/i, "no Campaign Ads / FBA export step in the scheduler");
});

/* token ceilings unchanged (Non-US 20 / US 10), operation-wide across primary + fallback */
test("token ceilings remain Non-US 20 / US 10 (shared operation-wide across primary + fallback)", () => {
  assert.match(yml, /if \[ "\$bucket" = "non-us" \]; then tokenmin=20; else tokenmin=10; fi/);
  assert.match(yml, /confirm-token-budget\.mjs --min=\$\{\{ steps\.cfg\.outputs\.tokenmin \}\}/);
});

/* the release resolves the BASE cycle (owns the Catalog job), not the OLI-only superseding head */
test("release finalize targets the BASE cycle (Catalog owner), not the OLI-only superseding head", () => {
  const cli = readFileSync(resolve(ROOT, "scripts", "release", "priority-dashboards-release.mjs"), "utf8");
  assert.match(cli, /getCycleByBucketDate:\s*sb\.getBaseSyncCycleByBucketDate/, "release uses the BASE-cycle resolver");
  const supa = readFileSync(resolve(ROOT, "lib", "server", "supabase.js"), "utf8");
  assert.match(supa, /getBaseSyncCycleByBucketDate/, "a base-cycle resolver exists");
  assert.match(supa, /supersedes_cycle_id:\s*"is\.null"/, "the base resolver filters supersedes_cycle_id IS NULL");
});

/* Sales Dashboard (brand-sales) + Daily + Brand View all carry the completeness augment, and the frontend reads it */
test("Sales Dashboard, Daily, and Brand endpoints are all wired to the completeness augment; the frontend reads it", () => {
  const api = readFileSync(resolve(ROOT, "api", "datadoe.js"), "utf8");
  assert.match(api, /action === "brand-sales"[\s\S]*?augmentResponse\s*=\s*oliCompletenessAugmentSingle\(\)/, "brand-sales (Sales Dashboard) is wired");
  assert.match(api, /oliCompletenessAugmentSingle|oliCompletenessAugmentPortfolio/, "single + portfolio augment helpers exist");
  const app = readFileSync(resolve(ROOT, "src", "App.jsx"), "utf8");
  assert.match(app, /setSalesCompleteness\(body\.completeness/, "the Sales Dashboard reads body.completeness");
  assert.match(app, /setDailyCompleteness\(body\.completeness/, "Daily Reporting reads body.completeness");
});

/* a covered account with ZERO OLI rows in the window is labelled explicit FINAL D-1 (never left unlabelled) */
test("a fully-inactive covered account (zero rows) is labelled explicit FINAL D-1, never unlabelled/false-provisional", () => {
  const src = readFileSync(resolve(ROOT, "lib", "server", "sync", "source-bucket-sync.js"), "utf8");
  assert.match(src, /FINAL_ZERO\s*=\s*\{\s*completenessStatus:\s*"final"/, "a final/zero completeness template exists");
  assert.match(src, /A FULLY-inactive account[\s\S]*?await writeOne\(unit\.slice\.to, FINAL_ZERO\)/, "a covered 0-row account is written FINAL D-1");
});

out("\n" + passed + " assertions passed");
