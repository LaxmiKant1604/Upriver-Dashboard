import assert from "node:assert/strict";

import worker, {
  POLLER_CRON,
  RECOVERY_GRACE_MINUTES,
  RECOVERY_WINDOW_MINUTES,
  REGION_SCHEDULE,
  decideRegion,
  isMatchingRun,
  recoveryPhase,
  runWatchdog,
  validateRunsResponse,
} from "../cloudflare/upriver-scheduler-watchdog.js";
import {
  CLOUDFLARE_RECOVERY_POLLER_CRON,
  RECOVERY_GRACE_MINUTES as APP_GRACE,
  RECOVERY_WINDOW_MINUTES as APP_WINDOW,
  REGION_SCHEDULE as APP_SCHEDULE,
} from "../lib/server/sync/campaign-region-routing.js";

let assertions = 0;
function check(value, message) {
  assert.ok(value, message);
  assertions += 1;
}
function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  assertions += 1;
}

equal(POLLER_CRON, CLOUDFLARE_RECOVERY_POLLER_CRON, "Worker poller cron matches app schedule");
equal(RECOVERY_GRACE_MINUTES, APP_GRACE, "Worker grace matches app schedule");
equal(RECOVERY_WINDOW_MINUTES, APP_WINDOW, "Worker window matches app schedule");
for (const region of Object.keys(REGION_SCHEDULE)) {
  equal(REGION_SCHEDULE[region].primaryCron, APP_SCHEDULE[region].primaryCron, `${region} primary cron matches`);
}

equal(recoveryPhase("india", "2026-09-10T03:26:59Z").phase, "before-grace", "India waits through grace");
equal(recoveryPhase("india", "2026-09-10T03:27:00Z").phase, "in-window", "India window opens at +20m");
equal(recoveryPhase("india", "2026-09-10T06:07:00Z").phase, "in-window", "India window includes +180m");
equal(recoveryPhase("india", "2026-09-10T06:07:01Z").phase, "after-window", "India window closes after +180m");
equal(recoveryPhase("europe-au", "2026-09-10T09:00:00Z").businessDate, "2026-09-09", "business date is D-1 UTC");

const indiaCycle = recoveryPhase("india", "2026-09-10T03:30:00Z");
const scheduledRun = {
  id: 1,
  event: "schedule",
  status: "completed",
  conclusion: "success",
  created_at: "2026-09-10T03:08:00Z",
  display_title: "scheduler-v2 7 3 * * *",
};
check(isMatchingRun(scheduledRun, indiaCycle), "exact scheduled identity matches");
check(!isMatchingRun({ ...scheduledRun, display_title: "x scheduler-v2 7 3 * * *" }, indiaCycle), "scheduled substring does not match");
for (const prefix of ["recovery", "cloudflare", "external"]) {
  check(isMatchingRun({
    ...scheduledRun,
    event: "workflow_dispatch",
    display_title: `scheduler-v2 india/${prefix}/india/2026-09-09`,
  }, indiaCycle), `${prefix} identity matches exactly`);
}
check(!isMatchingRun({
  ...scheduledRun,
  event: "workflow_dispatch",
  display_title: "scheduler-v2 india/cloudflare-x/india/2026-09-09",
}, indiaCycle), "look-alike dispatch identity does not match");

equal(validateRunsResponse(null).ok, false, "null response fails closed");
equal(validateRunsResponse({ workflow_runs: [] }).ok, false, "missing total count fails closed");
equal(validateRunsResponse({ total_count: 2, workflow_runs: [scheduledRun] }).ok, false, "truncated page fails closed");
equal(validateRunsResponse({ total_count: 1, workflow_runs: [{}] }).ok, false, "malformed run fails closed");
equal(validateRunsResponse({ total_count: 1, workflow_runs: [scheduledRun] }).ok, true, "complete page is accepted");

equal(decideRegion({ region: "india", now: "2026-09-10T03:30:00Z", apiOk: false, runs: [] }).action, "fail-closed", "API failure never dispatches");
equal(decideRegion({ region: "india", now: "2026-09-10T03:30:00Z", apiOk: true, runs: [] }).action, "dispatch", "proven missing run dispatches");
for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
  equal(decideRegion({ region: "india", now: "2026-09-10T03:30:00Z", apiOk: true, runs: [{ ...scheduledRun, status, conclusion: null }] }).action, "skip", `${status} run suppresses dispatch`);
}
equal(decideRegion({ region: "india", now: "2026-09-10T03:30:00Z", apiOk: true, runs: [scheduledRun] }).action, "skip", "successful run suppresses dispatch");
for (const conclusion of ["failure", "cancelled", "timed_out", "startup_failure"] ) {
  equal(decideRegion({ region: "india", now: "2026-09-10T03:30:00Z", apiOk: true, runs: [{ ...scheduledRun, conclusion }] }).action, "report-failed", `${conclusion} is reported and not retried`);
}

const env = {
  GITHUB_TOKEN: "test-token",
  GITHUB_OWNER: "owner",
  GITHUB_REPO: "repo",
  GITHUB_WORKFLOW: "scheduler-v2.yml",
};
const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  if ((options.method || "GET") === "POST") {
    return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
try {
  const result = await runWatchdog({ cron: POLLER_CRON, scheduledTime: Date.parse("2026-09-10T03:30:00Z") }, env);
  equal(result.dispatched, 1, "global poller dispatches only the open region");
  equal(calls.length, 2, "one read and one dispatch request were made");
  check(calls[0].url.includes("created=2026-09-10"), "run lookup is date-bounded");
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(body, {
    ref: "main",
    inputs: {
      region: "india",
      refresh_mode: "normal",
      dispatch_id: "cloudflare/india/2026-09-09",
      run_scope: "full",
    },
  });
  assertions += 1;
} finally {
  globalThis.fetch = originalFetch;
}

const noWindowCalls = [];
globalThis.fetch = async (...args) => {
  noWindowCalls.push(args);
  throw new Error("fetch must not run outside a recovery window");
};
try {
  const result = await runWatchdog({ cron: POLLER_CRON, scheduledTime: Date.parse("2026-09-10T07:00:00Z") }, env);
  equal(result.outcome, "no-open-window", "poller is a no-op outside all windows");
  equal(noWindowCalls.length, 0, "no GitHub request occurs outside all windows");
} finally {
  globalThis.fetch = originalFetch;
}

const failedCalls = [];
globalThis.fetch = async (url, options = {}) => {
  failedCalls.push({ url: String(url), options });
  return new Response(JSON.stringify({
    total_count: 1,
    workflow_runs: [{ ...scheduledRun, conclusion: "failure" }],
  }), { status: 200 });
};
try {
  const result = await runWatchdog({ cron: POLLER_CRON, scheduledTime: Date.parse("2026-09-10T03:30:00Z") }, env);
  equal(result.dispatched, 0, "failed run is not retried by integration path");
  equal(failedCalls.length, 1, "failed run causes lookup only, no POST");
} finally {
  globalThis.fetch = originalFetch;
}

const context = { waited: null, waitUntil(promise) { this.waited = promise; } };
await worker.scheduled({ cron: POLLER_CRON, scheduledTime: Date.parse("2026-09-10T07:00:00Z") }, env, context);
check(context.waited instanceof Promise, "scheduled handler registers the watchdog promise");
await context.waited;

console.log(`cloudflare-scheduler-watchdog: ${assertions} assertions passed`);
