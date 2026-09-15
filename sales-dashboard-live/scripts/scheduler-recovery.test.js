// Scheduler TRIGGER-RECOVERY proof suite (offline, ZERO network/DB).
//
// Proves the GitHub-native recovery backstop (scheduler-recovery.yml + lib/server/sync/scheduler-recovery.js +
// scripts/release/scheduler-recovery.mjs) recovers a MISSED individual cron without ever retrying a started-and-
// failed run and without creating a duplicate paid cycle. Reproduces the 2026-09-10 india incident (a primary cron
// that produced NO run at all) as a decision-model case.
//
// Every enumerated requirement test is covered: cron->region mapping, cron/IST/UTC agreement, grace + bounded
// window, queued/in-progress/success/failed classification, fail-closed on bad API responses, no duplicate
// dispatch on repeated checks, region/date isolation, GitHub+Cloudflare identity convergence on one durable cycle,
// and workflow permissions/syntax. 7-bit ASCII, LF, dynamic imports after arg parse.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // sales-dashboard-live
const WF = path.resolve(ROOT, "..", ".github", "workflows");
const readWf = (f) => readFileSync(path.join(WF, f), "utf8");

let R; // scheduler-recovery module
let freshnessOperationKey; // production durable-key function
let recoveryYml, schedulerYml, entrySrc;

// A synthetic scheduler-v2 run object (only the fields the matcher reads).
const scheduledRun = (cron, status, conclusion, createdAt, id = 1) => ({
  id, event: "schedule", status, conclusion: conclusion || null,
  display_title: "scheduler-v2 " + cron, created_at: createdAt,
});
const dispatchRun = (region, dispatchId, status, conclusion, createdAt, id = 2) => ({
  id, event: "workflow_dispatch", status, conclusion: conclusion || null,
  display_title: "scheduler-v2 " + region + "/" + dispatchId, created_at: createdAt,
});

// Fixed reference instants (india primary is 03:07 UTC; business date = 2026-09-09).
const INDIA_BEFORE_GRACE = "2026-09-10T03:15:00Z"; // 03:07 + 8m  (< 20m grace)
const INDIA_IN_WINDOW = "2026-09-10T03:40:00Z"; // 03:07 + 33m (in [03:27, 06:07])
const INDIA_AFTER_WINDOW = "2026-09-10T06:30:00Z"; // 03:07 + 3h23m (> 06:07)
const SCHEDULE_DATE = "2026-09-10";
const BUSINESS_DATE = "2026-09-09";

group("A. cron -> region mapping (exactly one correct region per cron)");

test("A1. each PRIMARY cron maps to exactly one region; the set is the three off-boundary primaries", () => {
  assert.equal(R.regionForPrimaryCron("7 3 * * *"), "india");
  assert.equal(R.regionForPrimaryCron("37 8 * * *"), "europe-au");
  assert.equal(R.regionForPrimaryCron("37 16 * * *"), "us-ca");
  const regions = R.scheduledRegions();
  assert.equal(regions.length, 3, "exactly three scheduled regions");
  assert.deepEqual(regions.map((r) => r.region).sort(), ["europe-au", "india", "us-ca"]);
  assert.deepEqual(regions.map((r) => r.primaryCron).sort(), ["37 16 * * *", "37 8 * * *", "7 3 * * *"].sort());
});

test("A1b. each GITHUB RECOVERY cron maps to exactly one correct region; unknown recovery cron -> null (fail closed)", () => {
  assert.equal(R.regionForRecoveryCron("47 3 * * *"), "india");
  assert.equal(R.regionForRecoveryCron("17 9 * * *"), "europe-au");
  assert.equal(R.regionForRecoveryCron("17 17 * * *"), "us-ca");
  // A primary cron, the Cloudflare */10 poller, and junk are NOT recovery crons.
  assert.equal(R.regionForRecoveryCron("7 3 * * *"), null);
  assert.equal(R.regionForRecoveryCron("*/10 * * * *"), null);
  assert.equal(R.regionForRecoveryCron("99 9 * * *"), null);
  // 1:1 and total: exactly the three recovery crons, each a distinct region.
  const mapped = ["47 3 * * *", "17 9 * * *", "17 17 * * *"].map((c) => R.regionForRecoveryCron(c));
  assert.deepEqual([...new Set(mapped)].sort(), ["europe-au", "india", "us-ca"]);
});

test("A2. an unknown / legacy cron maps to no region (null), and a non-daily cron throws (fail closed)", () => {
  assert.equal(R.regionForPrimaryCron("0 3 * * *"), null, "the retired :00 boundary cron no longer maps");
  assert.equal(R.regionForPrimaryCron("*/10 * * * *"), null);
  assert.throws(() => R.parseDailyCron("*/10 * * * *"), /not a strict daily cron/);
  assert.throws(() => R.parseDailyCron("61 3 * * *"), /out of range/);
});

group("B. cron / IST / UTC documentation agree (single source of truth; honest recovery model)");

test("B1. primary/recovery-eligibility/GitHub-recovery times agree with the crons; Cloudflare = ONE global */10 poller", () => {
  // Check the UTC/IST documentation strings against the crons + the grace/window constants (the crons + constants
  // drive the actual schedule; REGION_SCHEDULE is display/spec only). Represents Cloudflare's GLOBAL poller cron and
  // the per-region ELIGIBILITY window separately -- NOT three false per-region watchdog crons.
  return import("../lib/server/sync/campaign-region-routing.js").then(({ REGION_SCHEDULE, REGIONS, RECOVERY_GRACE_MINUTES, RECOVERY_WINDOW_MINUTES, CLOUDFLARE_RECOVERY_POLLER_CRON }) => {
    assert.equal(RECOVERY_GRACE_MINUTES, 20);
    assert.equal(RECOVERY_WINDOW_MINUTES, 180);
    assert.equal(CLOUDFLARE_RECOVERY_POLLER_CRON, "*/10 * * * *", "Cloudflare is ONE global poller, not per-region crons");
    const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
    for (const region of [REGIONS.INDIA, REGIONS.EUROPE_AU, REGIONS.US_CA]) {
      const s = REGION_SCHEDULE[region];
      // primary cron <-> primaryUtc; IST = UTC + 5:30.
      const { minute, hour } = R.parseDailyCron(s.primaryCron);
      assert.equal(hour * 60 + minute, toMin(s.primaryUtc), region + " primaryCron matches primaryUtc");
      assert.equal((toMin(s.istPrimary) - toMin(s.primaryUtc) + 1440) % 1440, 330, region + " IST primary = UTC + 5:30");
      // recovery eligibility = primary + grace; window end = primary + window.
      assert.equal((toMin(s.recoveryEligibleUtc) - toMin(s.primaryUtc) + 1440) % 1440, RECOVERY_GRACE_MINUTES, region + " recovery-eligible = primary + 20m");
      assert.equal((toMin(s.recoveryWindowEndUtc) - toMin(s.primaryUtc) + 1440) % 1440, RECOVERY_WINDOW_MINUTES, region + " recovery-window-end = primary + 180m");
      // GitHub recovery cron = primary + 40m, inside the window, IST = UTC + 5:30, maps back to this region.
      const g = R.parseDailyCron(s.githubRecoveryCron);
      assert.equal(g.hour * 60 + g.minute, toMin(s.githubRecoveryUtc), region + " githubRecoveryCron matches githubRecoveryUtc");
      assert.equal((toMin(s.githubRecoveryUtc) - toMin(s.primaryUtc) + 1440) % 1440, 40, region + " GitHub recovery = primary + 40m");
      assert.ok(toMin(s.githubRecoveryUtc) >= toMin(s.recoveryEligibleUtc) && toMin(s.githubRecoveryUtc) <= toMin(s.recoveryWindowEndUtc), region + " GitHub recovery inside the window");
      assert.equal((toMin(s.istGithubRecovery) - toMin(s.githubRecoveryUtc) + 1440) % 1440, 330, region + " IST GitHub recovery = UTC + 5:30");
      assert.equal(R.regionForRecoveryCron(s.githubRecoveryCron), region, region + " recovery cron maps back 1:1");
    }
    passed += 1; // this async test counts its own assertion block
    out("  ok  B1. primary/recovery-eligibility/GitHub-recovery times agree; Cloudflare = one global */10 poller");
  });
});

group("C. grace period + bounded window");

test("C1. before the 20-minute grace: phase before-grace, NO dispatch (even with an empty run list)", () => {
  const d = R.decideRecoveryForRegion({ region: "india", now: Date.parse(INDIA_BEFORE_GRACE), apiOk: true, runs: [] });
  assert.equal(d.phase, "before-grace");
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "before-grace");
});

test("C2. after the bounded 3-hour window: phase after-window, NO dispatch", () => {
  const d = R.decideRecoveryForRegion({ region: "india", now: Date.parse(INDIA_AFTER_WINDOW), apiOk: true, runs: [] });
  assert.equal(d.phase, "after-window");
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "window-closed");
});

group("D. the core decision matrix (in-window)");

test("D1. REPRODUCTION of the 2026-09-10 incident: no run was EVER created -> exactly one dispatch after grace", () => {
  const d = R.decideRecoveryForRegion({ region: "india", now: Date.parse(INDIA_IN_WINDOW), apiOk: true, runs: [] });
  assert.equal(d.phase, "in-window");
  assert.equal(d.action, "dispatch");
  assert.equal(d.reason, "no-run-created");
  assert.equal(d.dispatchId, "recovery/india/" + BUSINESS_DATE);
  // Across ALL regions at this instant, exactly ONE dispatch (only india is in-window; the other two are pre-grace).
  const all = R.decideRecovery({ now: Date.parse(INDIA_IN_WINDOW), apiOk: true, runs: [] });
  assert.equal(all.filter((x) => x.action === "dispatch").length, 1, "exactly one region dispatches");
  assert.equal(all.find((x) => x.region === "india").action, "dispatch");
  for (const other of ["europe-au", "us-ca"]) assert.equal(all.find((x) => x.region === other).action, "skip");
});

test("D2. a QUEUED matching scheduled run -> no dispatch", () => {
  const runs = [scheduledRun("7 3 * * *", "queued", null, "2026-09-10T03:07:20Z")];
  const d = R.decideRecoveryForRegion({ region: "india", now: Date.parse(INDIA_IN_WINDOW), apiOk: true, runs });
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "run-exists");
});

test("D3. an IN-PROGRESS matching scheduled run -> no dispatch", () => {
  const runs = [scheduledRun("7 3 * * *", "in_progress", null, "2026-09-10T03:07:20Z")];
  const d = R.decideRecoveryForRegion({ region: "india", now: Date.parse(INDIA_IN_WINDOW), apiOk: true, runs });
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "run-exists");
});

test("D4. a SUCCESSFUL matching scheduled run -> no dispatch", () => {
  const runs = [scheduledRun("7 3 * * *", "completed", "success", "2026-09-10T03:07:20Z")];
  const d = R.decideRecoveryForRegion({ region: "india", now: Date.parse(INDIA_IN_WINDOW), apiOk: true, runs });
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "run-exists");
});

test("D5. a FAILED matching run -> report-failed, NO dispatch, honest diagnostic (never auto-retry a started-and-failed run)", () => {
  for (const conclusion of ["failure", "cancelled", "timed_out", "startup_failure"]) {
    const runs = [scheduledRun("7 3 * * *", "completed", conclusion, "2026-09-10T03:07:20Z", 99)];
    const d = R.decideRecoveryForRegion({ region: "india", now: Date.parse(INDIA_IN_WINDOW), apiOk: true, runs });
    assert.equal(d.action, "report-failed", conclusion + " must report, not dispatch");
    assert.equal(d.reason, "run-failed-no-retry");
    assert.deepEqual(d.failedRunIds, [99]);
  }
});

group("E. fail-closed on a missing / malformed / truncated API response");

test("E1. apiOk=false in-window -> fail-closed, NO dispatch (a bad lookup never means 'missing')", () => {
  const d = R.decideRecoveryForRegion({ region: "india", now: Date.parse(INDIA_IN_WINDOW), apiOk: false, runs: [] });
  assert.equal(d.action, "fail-closed");
  assert.equal(d.reason, "api-unavailable");
});

test("E2. validateRunsResponse: well-formed complete payload is ok; missing/malformed/truncated fail closed", () => {
  assert.equal(R.validateRunsResponse({ total_count: 0, workflow_runs: [] }).ok, true);
  const good = { total_count: 1, workflow_runs: [scheduledRun("7 3 * * *", "queued", null, "2026-09-10T03:07:20Z")] };
  assert.equal(R.validateRunsResponse(good).ok, true);
  assert.equal(R.validateRunsResponse(null).ok, false, "null response");
  assert.equal(R.validateRunsResponse({}).ok, false, "no workflow_runs");
  assert.equal(R.validateRunsResponse({ total_count: 1, workflow_runs: "x" }).ok, false, "workflow_runs not array");
  assert.equal(R.validateRunsResponse({ workflow_runs: [] }).ok, false, "total_count missing");
  // total_count > returned length == truncated/paginated -> fail closed.
  assert.equal(R.validateRunsResponse({ total_count: 5, workflow_runs: [] }).ok, false, "truncated");
  // a run missing required fields fails closed.
  assert.equal(R.validateRunsResponse({ total_count: 1, workflow_runs: [{ event: "schedule", status: "queued" }] }).ok, false, "run missing created_at");
});

group("F. repeated checks + identity isolation (no duplicate dispatch; regions/dates never collide)");

test("F1. once a RECOVERY dispatch run exists, a later check does NOT dispatch again (idempotent)", () => {
  const runs = [dispatchRun("india", "recovery/india/" + BUSINESS_DATE, "in_progress", null, "2026-09-10T03:40:00Z")];
  const d = R.decideRecoveryForRegion({ region: "india", now: Date.parse("2026-09-10T03:55:00Z"), apiOk: true, runs });
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "run-exists");
});

test("F2. BOTH Cloudflare identities (cloudflare/ prod + external/) are treated as EXISTING -> no double-dispatch", () => {
  for (const prefix of ["cloudflare", "external"]) {
    const runs = [dispatchRun("india", prefix + "/india/" + BUSINESS_DATE, "in_progress", null, "2026-09-10T03:27:00Z")];
    const d = R.decideRecoveryForRegion({ region: "india", now: Date.parse(INDIA_IN_WINDOW), apiOk: true, runs });
    assert.equal(d.action, "skip", prefix + " must suppress dispatch");
    assert.equal(d.reason, "run-exists");
  }
  // Matching is EXACT run-name equality, never substring: a look-alike dispatch id does NOT suppress.
  const lookalike = [dispatchRun("india", "cloudflare-x/india/" + BUSINESS_DATE, "in_progress", null, "2026-09-10T03:27:00Z")];
  assert.equal(R.decideRecoveryForRegion({ region: "india", now: Date.parse(INDIA_IN_WINDOW), apiOk: true, runs: lookalike }).action, "dispatch", "substring must NOT match");
});

test("F3. runs for a DIFFERENT region or a DIFFERENT business date never match this cycle", () => {
  const now = Date.parse(INDIA_IN_WINDOW);
  // europe-au scheduled run + a europe-au watchdog dispatch must NOT satisfy india's cycle.
  const wrongRegion = [
    scheduledRun("37 8 * * *", "completed", "success", "2026-09-10T08:37:00Z", 7),
    dispatchRun("europe-au", "external/europe-au/" + BUSINESS_DATE, "in_progress", null, "2026-09-10T03:40:00Z", 8),
  ];
  assert.equal(R.decideRecoveryForRegion({ region: "india", now, apiOk: true, runs: wrongRegion }).action, "dispatch");
  // A recovery/watchdog run stamped with a DIFFERENT business date (yesterday's cycle) must NOT match today's.
  const wrongDate = [dispatchRun("india", "recovery/india/2026-09-08", "in_progress", null, "2026-09-10T03:40:00Z", 9)];
  assert.equal(R.decideRecoveryForRegion({ region: "india", now, apiOk: true, runs: wrongDate }).action, "dispatch");
  // A scheduled india run created YESTERDAY (created date != schedule date) must NOT match today's cycle.
  const staleSched = [scheduledRun("7 3 * * *", "completed", "success", "2026-09-09T03:07:20Z", 10)];
  assert.equal(R.decideRecoveryForRegion({ region: "india", now, apiOk: true, runs: staleSched }).action, "dispatch");
});

group("G. GitHub, legacy Cloudflare, new Cloudflare + primary triggers converge on ONE durable cycle");

test("G1. GitHub recovery, cloudflare/, external/ and the primary all resolve to the SAME durable region+D-1 cycle = the production freshness key", () => {
  const region = "india";
  const B = BUSINESS_DATE;
  const cycleKey = R.durableCycleKey(region, B);
  assert.equal(cycleKey, "scheduled-fresh/india/" + B);
  // Every trigger's dispatch id embeds (region, business-date); the dispatched run derives asof=business-date and
  // thus opkey = scheduled-fresh/<region>/<business-date> regardless of which trigger fired (dispatch_id is not in
  // the key). The primary scheduled run derives the same asof from the clock.
  const ids = [R.recoveryDispatchId(region, B), ...R.watchdogDispatchIds(region, B)];
  assert.deepEqual(ids, ["recovery/india/" + B, "cloudflare/india/" + B, "external/india/" + B]);
  for (const id of ids) assert.match(id, new RegExp("/" + region + "/" + B + "$"));
  // Prove the durable key equals the ACTUAL production key function (normal mode), not just our mirror -- so
  // GitHub, legacy Cloudflare, new Cloudflare and the primary all converge on the exact production op key.
  assert.equal(freshnessOperationKey({ mode: "normal", bucket: region, requestedAsOf: B }), cycleKey);
});

test("G2. business date = previous UTC day of the primary instant (matches the run's `date -u -d yesterday` asof)", () => {
  const d = R.decideRecoveryForRegion({ region: "india", now: Date.parse(INDIA_IN_WINDOW), apiOk: true, runs: [] });
  assert.equal(d.scheduleDate, SCHEDULE_DATE);
  assert.equal(d.businessDate, BUSINESS_DATE);
});

group("H. workflow permissions + syntax (static)");

test("H1. scheduler-recovery.yml: EXACTLY three daily recovery crons (3 jobs/day, not 144), least-privilege, own concurrency", () => {
  assert.match(recoveryYml, /^name:\s*scheduler-recovery/m);
  const crons = [...recoveryYml.matchAll(/- cron:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...crons].sort(), ["17 17 * * *", "17 9 * * *", "47 3 * * *"].sort(), "exactly three daily recovery crons (one per region)");
  assert.equal(crons.length, 3, "three recovery jobs/day, not an every-10-minute GitHub schedule");
  assert.ok(!crons.includes("*/10 * * * *"), "the frequent */10 poller is Cloudflare's job, NOT a GitHub cron");
  // Each recovery cron maps to exactly one region (via the pure module) -> deterministic 1:1.
  const mapped = crons.map((c) => R.regionForRecoveryCron(c));
  assert.deepEqual([...mapped].sort(), ["europe-au", "india", "us-ca"], "each cron maps to one distinct region");
  assert.match(recoveryYml, /permissions:\s*\n\s*#[\s\S]*?contents:\s*read\n\s*actions:\s*write/, "contents:read + actions:write only");
  assert.doesNotMatch(recoveryYml, /packages:|id-token:|deployments:|checks:/, "no extra permission scopes");
  assert.match(recoveryYml, /group:\s*scheduler-recovery\n\s*cancel-in-progress:\s*false/);
  assert.match(recoveryYml, /scheduler-recovery\.mjs/, "runs the recovery entrypoint");
  // The fired cron is passed through so the script can map it to one region deterministically.
  assert.match(recoveryYml, /--schedule="\$\{\{ github\.event\.schedule \}\}"/, "passes the fired cron to the script");
});

test("H1b. manual default is dry-run; scheduled runs are live; a scheduled recovery evaluates exactly ONE region", () => {
  // Workflow: the workflow_dispatch input defaults to dry-run; the scheduled path resolves to live.
  assert.match(recoveryYml, /inputs:\s*\n\s*mode:[\s\S]*?default:\s*"dry-run"/, "manual default is dry-run");
  assert.match(recoveryYml, /options:\s*\n\s*- dry-run\s*\n\s*- live/, "dry-run listed first (default), live opt-in");
  assert.match(recoveryYml, /github\.event_name == 'workflow_dispatch' && inputs\.mode \|\| 'live'/, "scheduled runs are live");
  // Entrypoint: absent --mode defaults to dry-run (manual-safe); unknown recovery cron fails closed.
  assert.match(entrySrc, /args\.get\("mode"\) \|\| "dry-run"/, "entrypoint mode defaults to dry-run");
  assert.match(entrySrc, /regionForRecoveryCron/, "entrypoint maps the fired cron to one region");
  assert.match(entrySrc, /unknown recovery cron[\s\S]*?process\.exit\(1\)/, "unknown recovery cron fails closed");
  // A scheduled recovery (one fired cron) evaluates exactly one region.
  const one = R.decideRecovery({ now: Date.parse(INDIA_IN_WINDOW), apiOk: true, runs: [], regions: ["india"] });
  assert.equal(one.length, 1);
  assert.equal(one[0].region, "india");
});

test("H2. the recovery workflow performs NO report/paid work (no DataDoe scripts, no npm ci, no DB secrets)", () => {
  // Scan the ACTIVE workflow body only -- strip full-line and trailing comments (the header comment legitimately
  // explains WHY there is no npm ci / no DataDoe secret, and must not itself trip the guard).
  const codeOnly = recoveryYml
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, "$1")) // drop trailing/full-line comments
    .join("\n");
  for (const forbidden of [
    "oli-refresh-d1", "scheduled-campaign-ads-refresh", "fba-plan-golive", "priority-dashboards-release",
    "priority-control-package", "listing-health-v3-ingestion", "report-materialization", "npm ci",
    "POSTGRES_URL", "SUPABASE_SERVICE_ROLE_KEY", "DATADOE_API_KEY",
  ]) {
    assert.ok(!codeOnly.includes(forbidden), "recovery workflow must not reference: " + forbidden);
  }
});

test("H3. scheduler-v2.yml is dispatch-only and all dispatchers share the region concurrency key", () => {
  const crons = [...schedulerYml.matchAll(/- cron:\s*"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(crons, [], "no native GitHub primary crons");
  const groupLine = schedulerYml.split("\n").find((l) => l.trim().startsWith("group: scheduler-v2-")) || "";
  assert.equal(groupLine.trim(), "group: scheduler-v2-${{ inputs.region }}");
});

test("H4. the entrypoint fails closed, delegates to the pure module, and never logs the token", () => {
  assert.match(entrySrc, /validateRunsResponse/);
  assert.match(entrySrc, /decideRecovery/);
  assert.match(entrySrc, /failClosed > 0 \|\| dispatchErrors > 0\) process\.exit\(1\)/, "red only on fail-closed / dispatch error");
  // No console line may echo the token or a complete Authorization header.
  for (const line of entrySrc.split("\n")) {
    if (/console\.(log|error)/.test(line)) {
      assert.ok(!/token|Authorization|Bearer/i.test(line), "no console line may print a credential: " + line.trim());
    }
  }
  // The dispatched run is a NORMAL, FULL-scope run (same as a scheduled run) -- never force-latest or bootstrap.
  assert.match(entrySrc, /refresh_mode:\s*"normal"[\s\S]*?run_scope:\s*"full"/, "recovery dispatches normal + full scope");
});

test("H5. NO report/token/budget/batching/D-1/publication behavior changed: scheduler-v2's paid pipeline anchors are intact", () => {
  // The recovery layer is trigger-only. Prove the scheduler-v2 report/publication invariants are byte-present and
  // unchanged (region+asof durable opkey, D-1 = previous UTC day, per-region token floors, strict-D1 publish, one
  // Campaign refresh). If any were altered by the trigger edits, these anchors would move.
  assert.match(schedulerYml, /opkey="scheduled-fresh\/\$region\/\$asof"/, "durable opkey = region + requestedAsOf (unchanged)");
  assert.match(schedulerYml, /asof="\$\(date -u -d 'yesterday' \+%Y-%m-%d\)"/, "D-1 = previous UTC day (unchanged)");
  assert.match(schedulerYml, /priority-dashboards-release\.mjs[^\n]*--strict-d1/, "strict-D1 publish (unchanged)");
  assert.match(schedulerYml, /"india"\)\s*tokenmin=10/, "india token floor (unchanged)");
  assert.match(schedulerYml, /"europe-au"\)\s*tokenmin=20/, "europe-au token floor (unchanged)");
  assert.equal((schedulerYml.match(/scheduled-campaign-ads-refresh\.mjs/g) || []).length, 1, "exactly ONE Campaign refresh (unchanged)");
  // The recovery module + entrypoint never touch a paid/report path in CODE (unambiguous identifiers only -- the
  // entrypoint legitimately uses GITHUB_TOKEN + fetch, and the module uses ESM `export`, so those are not forbidden).
  // Strip `//` line comments first: the module's own header HONESTLY says it "never touches DataDoe/DB", and that
  // self-describing comment must not itself trip the guard.
  const stripComments = (src) => src.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n").toLowerCase();
  const recoveryCode = stripComments(readFileSync(path.join(ROOT, "lib", "server", "sync", "scheduler-recovery.js"), "utf8"));
  const entryCode = stripComments(entrySrc);
  for (const forbidden of ["datadoe", "supabase", "postgres", "oli-refresh", "priority-dashboards", "fba-plan-golive", "campaign-ads-refresh"]) {
    assert.ok(!recoveryCode.includes(forbidden), "recovery module code must not reference paid/report concept: " + forbidden);
    assert.ok(!entryCode.includes(forbidden), "recovery entrypoint code must not reference paid/report concept: " + forbidden);
  }
});

async function main() {
  out("scheduler trigger-recovery proof suite");
  R = await import("../lib/server/sync/scheduler-recovery.js");
  ({ freshnessOperationKey } = await import("../lib/server/sync/source-oli-freshness.js"));
  recoveryYml = readWf("scheduler-recovery.yml");
  schedulerYml = readWf("scheduler-v2.yml");
  entrySrc = readFileSync(path.join(ROOT, "scripts", "release", "scheduler-recovery.mjs"), "utf8");

  let failures = 0;
  for (const t of tests) {
    if (t.marker) { out("-- " + t.marker); continue; }
    try {
      const r = t.fn();
      if (r && typeof r.then === "function") { await r; } else { passed += 1; out("  ok  " + t.name); }
    } catch (e) {
      failures += 1;
      out("FAIL  " + t.name);
      out(String((e && e.stack) || e));
    }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
}

main();
