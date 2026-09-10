#!/usr/bin/env node
// GitHub-native scheduler trigger RECOVERY -- thin entrypoint for scheduler-recovery.yml. It is the LOW-COST
// GitHub-side FINAL backstop: exactly three scheduled runs/day (one per region, at primary + 40m). The frequent
// (*/10) polling is Cloudflare's job; this is the independent safety net.
//
// It does NOT run any report job. It only: (1) reads a snapshot of recent scheduler-v2 workflow runs via the
// GitHub REST API using the workflow-scoped GITHUB_TOKEN, (2) asks the PURE decision module whether the region(s)
// under evaluation produced no run for today (past the 20-min grace, within the bounded 3-hour window), and (3) if
// so dispatches ONE scheduler-v2 run with dispatch_id `recovery/<region>/<business-date>`. On a scheduled run the
// fired cron (--schedule) is mapped deterministically to its ONE region; a manual run with no --schedule evaluates
// all regions (report-only under the dry-run default). All decision logic lives in
// lib/server/sync/scheduler-recovery.js and is unit-tested offline; this file is the transport + logging shell.
//
// FAIL CLOSED: a missing/malformed/truncated API response (or an unknown recovery cron) NEVER means "no run" -- it
// means we cannot safely decide, so we dispatch nothing and exit nonzero (the run goes red, observably, without
// touching production). It NEVER retries a run that started and failed, and NEVER prints the token or a complete
// Authorization header.
//
// Usage: node scripts/release/scheduler-recovery.mjs [--mode=live|dry-run] [--schedule=<cron>] [--now=<ISO8601>]
//   --mode         : live dispatches; dry-run decides + logs only (DEFAULT; manual runs must opt in to live).
//   --schedule     : the fired recovery cron (github.event.schedule); maps to one region. Empty => all regions.
//   --now=<ISO>    : override the clock (test/rehearsal only); defaults to the real current instant.
//
// 7-bit ASCII, LF.

import {
  SCHEDULER_WORKFLOW_FILE,
  SCHEDULED_REGIONS,
  decideRecovery,
  validateRunsResponse,
  utcDateString,
  regionForRecoveryCron,
} from "../../lib/server/sync/scheduler-recovery.js";

const args = new Map();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args.set(m[1], m[2] == null ? "true" : m[2]);
}
// Manual-safe DEFAULT is dry-run: a scheduled run is invoked with --mode=live by the workflow; a manual
// workflow_dispatch defaults to dry-run and must OPT IN to live. An absent/blank --mode is treated as dry-run.
const mode = String(args.get("mode") || "dry-run").trim() || "dry-run";
if (mode !== "live" && mode !== "dry-run") {
  console.error(`scheduler-recovery: invalid --mode=${mode} (expected live|dry-run)`);
  process.exit(2);
}
const nowArg = args.get("now");
const now = nowArg ? Date.parse(nowArg) : Date.now();
if (Number.isNaN(now)) {
  console.error(`scheduler-recovery: invalid --now=${nowArg}`);
  process.exit(2);
}

// Which region(s) to evaluate. A SCHEDULED recovery is fired by exactly one region's cron (passed as --schedule
// = github.event.schedule); map it deterministically to that ONE region and fail closed on an unknown cron. A
// manual run with no --schedule evaluates ALL regions (report-only under the dry-run default).
const firedSchedule = String(args.get("schedule") || "").trim();
let regions = SCHEDULED_REGIONS;
if (firedSchedule) {
  const region = regionForRecoveryCron(firedSchedule);
  if (!region) {
    console.error(`scheduler-recovery: unknown recovery cron ${JSON.stringify(firedSchedule)} -- refusing (fail closed).`);
    process.exit(1);
  }
  regions = [region];
}

const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
const repo = String(process.env.GITHUB_REPOSITORY || "").trim();
const apiBase = String(process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
const ref = String(process.env.GITHUB_REF_NAME || "main").trim() || "main";

const summaryLines = [];
const log = (s) => console.log(s);
const summarize = (s) => summaryLines.push(s);

async function readRuns() {
  if (!token || !repo) return { ok: false, runs: [], reason: "missing-token-or-repo" };
  const scheduleDate = utcDateString(now);
  const q = encodeURIComponent(">=" + scheduleDate);
  const url = `${apiBase}/repos/${repo}/actions/workflows/${SCHEDULER_WORKFLOW_FILE}/runs?created=${q}&per_page=100&exclude_pull_requests=true`;
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "upriver-scheduler-recovery",
      },
    });
  } catch (_e) {
    return { ok: false, runs: [], reason: "fetch-error" };
  }
  if (!res || !res.ok) return { ok: false, runs: [], reason: `http-${res ? res.status : "no-response"}` };
  let json;
  try {
    json = await res.json();
  } catch (_e) {
    return { ok: false, runs: [], reason: "json-parse-error" };
  }
  return validateRunsResponse(json);
}

async function dispatchRecovery(decision) {
  // POST a single scheduler-v2 workflow_dispatch for the region, converging on the SAME durable cycle key
  // (scheduled-fresh/<region>/<business-date>) as the missed primary + the Cloudflare recovery poller.
  const res = await fetch(`${apiBase}/repos/${repo}/actions/workflows/${SCHEDULER_WORKFLOW_FILE}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "upriver-scheduler-recovery",
    },
    body: JSON.stringify({
      ref,
      inputs: { region: decision.region, refresh_mode: "normal", dispatch_id: decision.dispatchId, run_scope: "full" },
    }),
  });
  if (!res || (res.status !== 204 && !res.ok)) {
    throw new Error(`RECOVERY_DISPATCH_FAILED: HTTP ${res ? res.status : "no-response"}`);
  }
}

async function main() {
  const { ok: apiOk, runs, reason: apiReason } = await readRuns();
  const decisions = decideRecovery({ now, apiOk, runs, regions });

  let failClosed = 0;
  let dispatched = 0;
  let dispatchErrors = 0;
  let reportedFailed = 0;
  let actionable = 0;

  log(
    `scheduler-recovery[${mode}] now=${new Date(now).toISOString()} apiOk=${apiOk} apiReason=${apiReason} ` +
      `firedSchedule=${firedSchedule || "(manual/all-regions)"} regions=${regions.join(",")} ` +
      `runsFetched=${Array.isArray(runs) ? runs.length : 0}`,
  );

  for (const d of decisions) {
    // Log the expected time, region, date, lookup outcome and chosen action for EVERY region (auditable trail).
    const line =
      `region=${d.region} expected=${d.expectedUtc} grace>=${d.graceStartUtc} window<=${d.windowEndUtc} ` +
      `businessDate=${d.businessDate} cycleKey=${d.durableCycleKey} phase=${d.phase} matched=${d.matchedCount} ` +
      `action=${d.action} reason=${d.reason}`;
    log("  " + line);

    if (d.phase === "before-grace" || d.phase === "after-window") continue; // out of window: nothing to do

    actionable += 1;

    if (d.action === "fail-closed") {
      failClosed += 1;
      console.error(`  FAIL-CLOSED region=${d.region}: cannot decide (reason=${apiReason}); dispatching nothing.`);
      summarize(`- **${d.region}**: FAIL-CLOSED (lookup unusable: ${apiReason}) -- no dispatch, no retry.`);
      continue;
    }
    if (d.action === "report-failed") {
      reportedFailed += 1;
      console.error(
        `  FAILED-RUN-NO-RETRY region=${d.region}: a run for ${d.businessDate} started and did not succeed ` +
          `(runIds=${(d.failedRunIds || []).join(",")}); recovery does NOT retry a started-and-failed run.`,
      );
      summarize(`- **${d.region}**: a run started and FAILED for ${d.businessDate} -- reported, NOT retried (trigger delivery worked).`);
      continue;
    }
    if (d.action === "skip" && d.reason === "run-exists") {
      summarize(`- **${d.region}**: a matching run already exists for ${d.businessDate} (queued/in-progress/success) -- no dispatch.`);
      continue;
    }
    if (d.action === "dispatch") {
      if (mode === "dry-run") {
        log(`  DRY-RUN would dispatch scheduler-v2 region=${d.region} dispatch_id=${d.dispatchId} run_scope=full`);
        summarize(`- **${d.region}**: DRY-RUN -- would dispatch recovery for ${d.businessDate} (dispatch_id=${d.dispatchId}).`);
        continue;
      }
      try {
        await dispatchRecovery(d);
        dispatched += 1;
        log(`  DISPATCHED scheduler-v2 region=${d.region} dispatch_id=${d.dispatchId} run_scope=full ref=${ref}`);
        summarize(`- **${d.region}**: no run was created for ${d.businessDate} -- dispatched ONE recovery run (dispatch_id=${d.dispatchId}).`);
      } catch (e) {
        dispatchErrors += 1;
        console.error(`  DISPATCH-ERROR region=${d.region}: ${e && e.message ? e.message : e}`);
        summarize(`- **${d.region}**: recovery dispatch FAILED to POST -- ${e && e.message ? e.message : e}.`);
      }
    }
  }

  if (!actionable) log("scheduler-recovery: no region is within its recovery window right now (clean no-op).");

  // GitHub step summary (best-effort; never fails the run).
  if (process.env.GITHUB_STEP_SUMMARY && summaryLines.length) {
    try {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### scheduler-recovery (${mode})\n` + summaryLines.join("\n") + "\n",
      );
    } catch (_e) {
      /* summary is best-effort */
    }
  }

  log(
    `scheduler-recovery: done mode=${mode} actionable=${actionable} dispatched=${dispatched} ` +
      `reportedFailed=${reportedFailed} failClosed=${failClosed} dispatchErrors=${dispatchErrors}`,
  );

  // The recovery run is RED only when it could NOT safely decide (fail-closed) or a dispatch POST failed. A
  // reported-but-not-retried FAILED underlying run is already red in Actions on its own; recovery did its job.
  if (failClosed > 0 || dispatchErrors > 0) process.exit(1);
}

main().catch((e) => {
  console.error("scheduler-recovery: unexpected error:", e && e.stack ? e.stack : e);
  process.exit(1);
});
