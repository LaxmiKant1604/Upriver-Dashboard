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

test("A1. each primary cron maps to exactly one region; the set is the three new off-boundary primaries", () => {
  assert.equal(R.regionForPrimaryCron("7 3 * * *"), "india");
  assert.equal(R.regionForPrimaryCron("37 8 * * *"), "europe-au");
  assert.equal(R.regionForPrimaryCron("37 16 * * *"), "us-ca");
  const regions = R.scheduledRegions();
  assert.equal(regions.length, 3, "exactly three scheduled regions");
  assert.deepEqual(regions.map((r) => r.region).sort(), ["europe-au", "india", "us-ca"]);
  assert.deepEqual(regions.map((r) => r.primaryCron).sort(), ["37 16 * * *", "37 8 * * *", "7 3 * * *"].sort());
});

test("A2. an unknown / legacy cron maps to no region (null), and a non-daily cron throws (fail closed)", () => {
  assert.equal(R.regionForPrimaryCron("0 3 * * *"), null, "the retired :00 boundary cron no longer maps");
  assert.equal(R.regionForPrimaryCron("*/10 * * * *"), null);
  assert.throws(() => R.parseDailyCron("*/10 * * * *"), /not a strict daily cron/);
  assert.throws(() => R.parseDailyCron("61 3 * * *"), /out of range/);
});

group("B. cron / IST / UTC documentation agree (single source of truth)");

test("B1. each region's primaryCron minute/hour == primaryUtc, and IST == UTC + 5:30; watchdog == primary + 20m", () => {
  // Check the UTC/IST documentation strings against the crons (the crons drive the actual schedule).
  return import("../lib/server/sync/campaign-region-routing.js").then(({ REGION_SCHEDULE, REGIONS }) => {
    const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
    for (const region of [REGIONS.INDIA, REGIONS.EUROPE_AU, REGIONS.US_CA]) {
      const s = REGION_SCHEDULE[region];
      const { minute, hour } = R.parseDailyCron(s.primaryCron);
      assert.equal(hour * 60 + minute, toMin(s.primaryUtc), region + " primaryCron matches primaryUtc");
      assert.equal((toMin(s.istPrimary) - toMin(s.primaryUtc) + 1440) % 1440, 330, region + " IST primary = UTC + 5:30");
      const w = R.parseDailyCron(s.watchdogCron);
      assert.equal(w.hour * 60 + w.minute, toMin(s.watchdogUtc), region + " watchdogCron matches watchdogUtc");
      assert.equal((toMin(s.watchdogUtc) - toMin(s.primaryUtc) + 1440) % 1440, 20, region + " watchdog = primary + 20m");
      assert.equal((toMin(s.istWatchdog) - toMin(s.watchdogUtc) + 1440) % 1440, 330, region + " IST watchdog = UTC + 5:30");
    }
    passed += 1; // this async test counts its own assertion block
    out("  ok  B1. cron/IST/UTC documentation agree (single source of truth)");
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

test("F2. a CLOUDFLARE WATCHDOG dispatch run is treated as EXISTING -> GitHub recovery does not double-dispatch", () => {
  const runs = [dispatchRun("india", "external/india/" + BUSINESS_DATE, "in_progress", null, "2026-09-10T03:27:00Z")];
  const d = R.decideRecoveryForRegion({ region: "india", now: Date.parse(INDIA_IN_WINDOW), apiOk: true, runs });
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "run-exists");
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

group("G. GitHub + Cloudflare identities converge on ONE durable cycle");

test("G1. recovery + watchdog dispatch ids both resolve to the SAME durable cycle key = the production freshness key", () => {
  const region = "india";
  const B = BUSINESS_DATE;
  const cycleKey = R.durableCycleKey(region, B);
  assert.equal(cycleKey, "scheduled-fresh/india/" + B);
  // Both external triggers embed (region, business-date); the dispatched run derives asof=business-date and thus
  // opkey = scheduled-fresh/<region>/<business-date> regardless of which trigger fired.
  assert.match(R.recoveryDispatchId(region, B), new RegExp("/" + region + "/" + B + "$"));
  assert.match(R.watchdogDispatchId(region, B), new RegExp("/" + region + "/" + B + "$"));
  // Prove it equals the ACTUAL production key function (normal mode), not just our mirror.
  assert.equal(freshnessOperationKey({ mode: "normal", bucket: region, requestedAsOf: B }), cycleKey);
});

test("G2. business date = previous UTC day of the primary instant (matches the run's `date -u -d yesterday` asof)", () => {
  const d = R.decideRecoveryForRegion({ region: "india", now: Date.parse(INDIA_IN_WINDOW), apiOk: true, runs: [] });
  assert.equal(d.scheduleDate, SCHEDULE_DATE);
  assert.equal(d.businessDate, BUSINESS_DATE);
});

group("H. workflow permissions + syntax (static)");

test("H1. scheduler-recovery.yml: */10 cron, least-privilege permissions, own concurrency, node script only", () => {
  assert.match(recoveryYml, /^name:\s*scheduler-recovery/m);
  const crons = [...recoveryYml.matchAll(/- cron:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(crons, ["*/10 * * * *"], "exactly the every-10-minute recovery cron");
  assert.match(recoveryYml, /permissions:\s*\n\s*#[\s\S]*?contents:\s*read\n\s*actions:\s*write/, "contents:read + actions:write only");
  assert.doesNotMatch(recoveryYml, /packages:|id-token:|deployments:|checks:/, "no extra permission scopes");
  assert.match(recoveryYml, /group:\s*scheduler-recovery\n\s*cancel-in-progress:\s*false/);
  assert.match(recoveryYml, /scheduler-recovery\.mjs/, "runs the recovery entrypoint");
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

test("H3. scheduler-v2.yml carries the NEW off-boundary primaries + matching case + concurrency (lockstep)", () => {
  const crons = [...schedulerYml.matchAll(/- cron:\s*"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(crons, ["37 16 * * *", "37 8 * * *", "7 3 * * *"].sort(), "exactly the three new primaries");
  assert.match(schedulerYml, /"7 3 \* \* \*"\)\s*region="india"/);
  assert.match(schedulerYml, /"37 8 \* \* \*"\)\s*region="europe-au"/);
  assert.match(schedulerYml, /"37 16 \* \* \*"\)\s*region="us-ca"/);
  const groupLine = schedulerYml.split("\n").find((l) => l.trim().startsWith("group: scheduler-v2-")) || "";
  assert.match(groupLine, /'7 3 \* \* \*' && 'india'/);
  assert.match(groupLine, /'37 8 \* \* \*' && 'europe-au'/);
  assert.match(groupLine, /'37 16 \* \* \*' && 'us-ca'/);
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
