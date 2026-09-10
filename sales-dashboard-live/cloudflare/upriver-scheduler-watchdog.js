// Cloudflare recovery poller for scheduler-v2.
//
// This Worker performs no report work. Every ten minutes it checks only the
// region whose bounded recovery window is open. It dispatches scheduler-v2
// only when GitHub proves that no matching run was ever created. API errors,
// malformed/truncated responses, active/successful runs, and completed failed
// runs all cause a fail-closed no-dispatch outcome.

export const POLLER_CRON = "*/10 * * * *";
export const RECOVERY_GRACE_MINUTES = 20;
export const RECOVERY_WINDOW_MINUTES = 180;

export const REGION_SCHEDULE = Object.freeze({
  india: Object.freeze({ primaryCron: "7 3 * * *", hour: 3, minute: 7 }),
  "europe-au": Object.freeze({ primaryCron: "37 8 * * *", hour: 8, minute: 37 }),
  "us-ca": Object.freeze({ primaryCron: "37 16 * * *", hour: 16, minute: 37 }),
});

// Accepted only during the schedule migration. Once the account carries only
// POLLER_CRON these aliases are inert, but retaining them makes rollback safe.
const LEGACY_CRON_REGIONS = Object.freeze({
  "20 3 * * *": "india",
  "50 8 * * *": "europe-au",
  "50 16 * * *": "us-ca",
});

const IN_FLIGHT_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting",
  "pending",
  "requested",
]);

function utcDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function previousUtcDate(value) {
  const d = new Date(value);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return new Date(midnight - 86400000).toISOString().slice(0, 10);
}

function expectedPrimary(region, now) {
  const config = REGION_SCHEDULE[region];
  const d = new Date(now);
  return new Date(Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    config.hour,
    config.minute,
    0,
    0,
  ));
}

export function recoveryPhase(region, now) {
  const primary = expectedPrimary(region, now);
  const graceStart = new Date(primary.getTime() + RECOVERY_GRACE_MINUTES * 60000);
  const windowEnd = new Date(primary.getTime() + RECOVERY_WINDOW_MINUTES * 60000);
  const time = new Date(now).getTime();
  const phase = time < graceStart.getTime()
    ? "before-grace"
    : time <= windowEnd.getTime()
      ? "in-window"
      : "after-window";
  return {
    region,
    primaryCron: REGION_SCHEDULE[region].primaryCron,
    scheduleDate: utcDate(primary),
    businessDate: previousUtcDate(primary),
    phase,
  };
}

function scheduledRunName(primaryCron) {
  return `scheduler-v2 ${primaryCron}`;
}

function dispatchRunName(region, prefix, businessDate) {
  return `scheduler-v2 ${region}/${prefix}/${region}/${businessDate}`;
}

function runTitle(run) {
  return String(run?.display_title != null ? run.display_title : run?.name || "");
}

export function isMatchingRun(run, cycle) {
  if (!run || typeof run !== "object") return false;
  if (run.event === "schedule") {
    const createdAt = Date.parse(run.created_at || "");
    return Number.isFinite(createdAt)
      && utcDate(createdAt) === cycle.scheduleDate
      && runTitle(run) === scheduledRunName(cycle.primaryCron);
  }
  if (run.event !== "workflow_dispatch") return false;
  const accepted = ["recovery", "cloudflare", "external"].map((prefix) =>
    dispatchRunName(cycle.region, prefix, cycle.businessDate));
  return accepted.includes(runTitle(run));
}

export function validateRunsResponse(value) {
  if (!value || typeof value !== "object") return { ok: false, reason: "response-not-object", runs: [] };
  if (!Array.isArray(value.workflow_runs)) return { ok: false, reason: "workflow_runs-not-array", runs: [] };
  if (!Number.isInteger(value.total_count) || value.total_count < 0) {
    return { ok: false, reason: "total_count-invalid", runs: [] };
  }
  if (value.total_count !== value.workflow_runs.length) {
    return { ok: false, reason: "response-truncated-or-inconsistent", runs: [] };
  }
  for (const run of value.workflow_runs) {
    if (!run || typeof run !== "object") return { ok: false, reason: "run-not-object", runs: [] };
    if (run.event == null || run.status == null || run.created_at == null) {
      return { ok: false, reason: "run-missing-fields", runs: [] };
    }
    if (run.display_title == null && run.name == null) {
      return { ok: false, reason: "run-missing-title", runs: [] };
    }
  }
  return { ok: true, reason: "ok", runs: value.workflow_runs };
}

function isCoveredRun(run) {
  if (IN_FLIGHT_STATUSES.has(String(run.status || ""))) return true;
  return run.status === "completed" && run.conclusion === "success";
}

export function decideRegion({ region, now, apiOk, runs }) {
  const cycle = recoveryPhase(region, now);
  if (cycle.phase !== "in-window") {
    return { ...cycle, action: "skip", reason: cycle.phase };
  }
  if (!apiOk) return { ...cycle, action: "fail-closed", reason: "api-unavailable" };

  const matching = (Array.isArray(runs) ? runs : []).filter((run) => isMatchingRun(run, cycle));
  if (matching.some(isCoveredRun)) {
    return { ...cycle, action: "skip", reason: "run-exists", matchedCount: matching.length };
  }
  if (matching.length > 0) {
    return {
      ...cycle,
      action: "report-failed",
      reason: "run-failed-no-retry",
      matchedCount: matching.length,
      failedRunIds: matching.map((run) => run.id).filter((id) => id != null),
    };
  }
  return { ...cycle, action: "dispatch", reason: "no-run-created", matchedCount: 0 };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function requireConfiguration(env) {
  const required = ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO", "GITHUB_WORKFLOW"];
  const missing = required.filter((key) => !String(env[key] || "").trim());
  if (missing.length > 0) throw new Error(`Missing Cloudflare variable(s): ${missing.join(", ")}`);
}

async function githubRequest(env, path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "upriver-scheduler-watchdog",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub API request failed (${response.status})`);
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("GitHub API returned malformed JSON");
  }
}

async function readRuns(env, scheduleDate) {
  const owner = encodeURIComponent(env.GITHUB_OWNER);
  const repo = encodeURIComponent(env.GITHUB_REPO);
  const workflow = encodeURIComponent(env.GITHUB_WORKFLOW);
  const query = new URLSearchParams({
    branch: "main",
    created: scheduleDate,
    exclude_pull_requests: "true",
    per_page: "100",
    page: "1",
  });
  return githubRequest(
    env,
    `/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?${query}`,
  );
}

async function dispatchWorkflow(env, region, businessDate) {
  const owner = encodeURIComponent(env.GITHUB_OWNER);
  const repo = encodeURIComponent(env.GITHUB_REPO);
  const workflow = encodeURIComponent(env.GITHUB_WORKFLOW);
  await githubRequest(env, `/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ref: "main",
      inputs: {
        region,
        refresh_mode: "normal",
        dispatch_id: `cloudflare/${region}/${businessDate}`,
        run_scope: "full",
      },
    }),
  });
}

function regionsForInvocation(cron) {
  if (cron === POLLER_CRON) return Object.keys(REGION_SCHEDULE);
  const legacyRegion = LEGACY_CRON_REGIONS[cron];
  return legacyRegion ? [legacyRegion] : [];
}

export async function runWatchdog(controller, env) {
  requireConfiguration(env);
  const cron = String(controller.cron || "");
  const regions = regionsForInvocation(cron);
  if (regions.length === 0) throw new Error(`Unknown Cloudflare cron: ${cron}`);

  const now = new Date(Number(controller.scheduledTime || Date.now()));
  const candidates = regions
    .map((region) => recoveryPhase(region, now))
    .filter((cycle) => cycle.phase === "in-window");
  if (candidates.length === 0) {
    console.log(`Watchdog no-op: no regional recovery window is open at ${now.toISOString()}.`);
    return { outcome: "no-open-window", at: now.toISOString() };
  }

  const scheduleDates = [...new Set(candidates.map((cycle) => cycle.scheduleDate))];
  if (scheduleDates.length !== 1) throw new Error("Recovery candidates span multiple UTC dates");

  let validated;
  try {
    validated = validateRunsResponse(await readRuns(env, scheduleDates[0]));
  } catch (error) {
    console.error(`Watchdog failed closed: ${error?.message || "GitHub lookup failed"}.`);
    return { outcome: "failed-closed", reason: "github-api-unavailable", dispatched: 0 };
  }
  if (!validated.ok) {
    console.error(`Watchdog failed closed: unusable GitHub run list (${validated.reason}).`);
    return { outcome: "failed-closed", reason: validated.reason, dispatched: 0 };
  }

  const decisions = candidates.map((cycle) => decideRegion({
    region: cycle.region,
    now,
    apiOk: true,
    runs: validated.runs,
  }));
  for (const decision of decisions) {
    if (decision.action === "dispatch") {
      await dispatchWorkflow(env, decision.region, decision.businessDate);
      console.log(`Watchdog dispatched ${decision.region} for ${decision.businessDate}.`);
    } else if (decision.action === "report-failed") {
      console.error(
        `Watchdog did not retry ${decision.region}: matching run(s) finished unsuccessfully (${decision.failedRunIds.join(",") || "id unavailable"}).`,
      );
    } else {
      console.log(`Watchdog skipped ${decision.region}: ${decision.reason}.`);
    }
  }
  return {
    outcome: "evaluated",
    dispatched: decisions.filter((decision) => decision.action === "dispatch").length,
    decisions,
  };
}

export default {
  async fetch(_request, env) {
    return json({
      ok: true,
      service: "upriver-scheduler-watchdog",
      configured: Boolean(
        env.GITHUB_TOKEN
        && env.GITHUB_OWNER
        && env.GITHUB_REPO
        && env.GITHUB_WORKFLOW
      ),
      pollerCron: POLLER_CRON,
      recoveryGraceMinutes: RECOVERY_GRACE_MINUTES,
      recoveryWindowMinutes: RECOVERY_WINDOW_MINUTES,
      regions: Object.keys(REGION_SCHEDULE),
      note: "Dispatches only when GitHub proves no matching regional run was created; failures are reported, never retried.",
    });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runWatchdog(controller, env));
  },
};
