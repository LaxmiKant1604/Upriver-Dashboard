// GitHub-native SCHEDULER TRIGGER RECOVERY -- pure, offline, deterministic decision logic.
//
// WHY: GitHub's scheduled-cron delivery is best-effort. On 2026-09-10 the india 03:00 primary produced NO
// workflow run at all (it did not start, so it did not "fail" -- there was simply nothing to fail), and the
// external Cloudflare watchdog also produced no invocation. account-onboarding kept running, so Actions was not
// globally disabled. This module powers a lightweight GitHub-native backstop (scheduler-recovery.yml, every 10
// min) that re-dispatches scheduler-v2 ONLY when a region's cron produced no run for the day -- without ever
// retrying a run that started and failed, and without creating a duplicate paid cycle.
//
// It NEVER performs report work, NEVER touches DataDoe/DB, and NEVER prints credentials. It only decides, from a
// snapshot of scheduler-v2 workflow runs + the current instant, whether to dispatch. All HTTP lives in the thin
// entrypoint (scripts/release/scheduler-recovery.mjs); everything here is a pure function of its inputs.
//
// CONVERGENCE (anti-duplicate-spend): the durable cycle identity is region + requestedAsOf (D-1 = yesterday UTC),
// i.e. opkey `scheduled-fresh/<region>/<D-1>`, computed INSIDE the dispatched run from the clock -- never from the
// cron string or the dispatch_id. A scheduled run, the Cloudflare watchdog dispatch (external/<region>/<D-1>) and a
// recovery dispatch (recovery/<region>/<D-1>) therefore ALL resolve to ONE opkey, ONE token/create budget and ONE
// cycle. The read-only duplicate guard makes an already-published D-1 a zero-write no-op. This module additionally
// treats a watchdog OR a prior recovery run as an EXISTING run, so simultaneous GitHub + Cloudflare recovery never
// double-dispatches once either run is visible.
//
// 7-bit ASCII, LF. No external deps.

import { REGIONS, REGION_SCHEDULE } from "./campaign-region-routing.js";

export const SCHEDULER_WORKFLOW_FILE = "scheduler-v2.yml";
export const RUN_NAME_PREFIX = "scheduler-v2 "; // run-name is `scheduler-v2 <cron>` (schedule) or `scheduler-v2 <region>/<dispatch_id>` (dispatch)
export const RECOVERY_GRACE_MINUTES = 20; // wait this long after the primary before recovery may act
export const RECOVERY_WINDOW_MINUTES = 180; // bounded: stop checking 3h after the primary
export const RECOVERY_DISPATCH_PREFIX = "recovery"; // recovery/<region>/<business-date>
export const WATCHDOG_DISPATCH_PREFIX = "external"; // external/<region>/<business-date> (Cloudflare)

// The regions that carry a daily primary schedule, in a stable order.
export const SCHEDULED_REGIONS = Object.freeze([REGIONS.INDIA, REGIONS.EUROPE_AU, REGIONS.US_CA]);

// GitHub run statuses that mean "a run exists and is not yet a finished failure".
const IN_FLIGHT_STATUSES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

// Parse a strict daily cron "<minute> <hour> * * *" -> { minute, hour }. Anything else throws (fail closed).
export function parseDailyCron(cron) {
  const m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(String(cron || "").trim());
  if (!m) throw new Error("scheduler-recovery: not a strict daily cron: " + JSON.stringify(cron));
  const minute = Number(m[1]);
  const hour = Number(m[2]);
  if (!(minute >= 0 && minute <= 59) || !(hour >= 0 && hour <= 23)) {
    throw new Error("scheduler-recovery: cron out of range: " + JSON.stringify(cron));
  }
  return { minute, hour };
}

// [{ region, primaryCron, minute, hour }] derived from REGION_SCHEDULE (single source of truth).
export function scheduledRegions() {
  return SCHEDULED_REGIONS.map((region) => {
    const primaryCron = REGION_SCHEDULE[region].primaryCron;
    const { minute, hour } = parseDailyCron(primaryCron);
    return { region, primaryCron, minute, hour };
  });
}

// Map a scheduled primary cron string -> its region, or null if it is not one of the known primaries.
export function regionForPrimaryCron(cron) {
  const want = String(cron || "").trim();
  for (const r of scheduledRegions()) if (r.primaryCron === want) return r.region;
  return null;
}

// UTC calendar helpers (never local time).
export function utcDateString(date) {
  const d = new Date(date);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
// The business date a run started at `date` will publish = the PREVIOUS UTC day (matches `date -u -d yesterday`
// and the workflow's asof). Uses a UTC-midnight subtraction so it is DST-free and identical to the run's own value.
export function previousUtcDateString(date) {
  const d = new Date(date);
  const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return new Date(utcMidnight - 86400000).toISOString().slice(0, 10);
}

// The Date of TODAY's (UTC) primary fire instant for a region, relative to `now`.
export function expectedPrimaryUtc(region, now) {
  const { minute, hour } = parseDailyCron(REGION_SCHEDULE[region].primaryCron);
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute, 0, 0));
}

// The recovery phase for a region at instant `now`.
//   before-grace : now < primary + 20m           -> never dispatch (give the primary + delivery jitter time)
//   in-window    : primary+20m <= now <= primary+180m -> eligible to check + possibly dispatch
//   after-window : now > primary + 180m           -> bounded window closed, never dispatch
export function recoveryPhase(region, now) {
  const expectedUtc = expectedPrimaryUtc(region, now);
  const graceStartUtc = new Date(expectedUtc.getTime() + RECOVERY_GRACE_MINUTES * 60000);
  const windowEndUtc = new Date(expectedUtc.getTime() + RECOVERY_WINDOW_MINUTES * 60000);
  const t = new Date(now).getTime();
  let phase;
  if (t < graceStartUtc.getTime()) phase = "before-grace";
  else if (t <= windowEndUtc.getTime()) phase = "in-window";
  else phase = "after-window";
  return {
    region,
    primaryCron: REGION_SCHEDULE[region].primaryCron,
    expectedUtc,
    graceStartUtc,
    windowEndUtc,
    // The schedule (calendar) date the primary was due, and the business date (D-1) the run publishes. All three
    // regional windows fall well within one UTC day, so scheduleDate == utcDateString(expectedUtc) == utcDateString(now).
    scheduleDate: utcDateString(expectedUtc),
    businessDate: previousUtcDateString(expectedUtc),
    phase,
  };
}

// Deterministic run-name identities (must match scheduler-v2.yml's run-name template EXACTLY).
export function scheduledRunName(cron) {
  return RUN_NAME_PREFIX + cron;
}
export function dispatchRunName(region, dispatchId) {
  return RUN_NAME_PREFIX + region + "/" + dispatchId;
}
export function recoveryDispatchId(region, businessDate) {
  return RECOVERY_DISPATCH_PREFIX + "/" + region + "/" + businessDate;
}
export function watchdogDispatchId(region, businessDate) {
  return WATCHDOG_DISPATCH_PREFIX + "/" + region + "/" + businessDate;
}
// The durable cycle identity every trigger for this region+day converges on (mirrors the workflow's opkey).
export function durableCycleKey(region, businessDate) {
  return "scheduled-fresh/" + region + "/" + businessDate;
}

// A single GitHub workflow-run object as returned by the runs API (only the fields we rely on).
function runTitle(run) {
  // display_title is the resolved run-name; fall back to name only if display_title is absent.
  return String((run && (run.display_title != null ? run.display_title : run.name)) || "");
}

// Does a run belong to THIS region's cycle for (scheduleDate, businessDate)? Matches EXACTLY three deterministic
// identities: the scheduled primary (run-name == `scheduler-v2 <primaryCron>`, created on the schedule date), a
// prior recovery dispatch, or a Cloudflare watchdog dispatch. A bootstrap/ad-hoc dispatch (any other dispatch_id)
// is deliberately NOT matched.
export function isMatchingRun(run, { region, primaryCron, scheduleDate, businessDate }) {
  if (!run || typeof run !== "object") return false;
  const title = runTitle(run);
  const event = String(run.event || "");
  if (event === "schedule") {
    if (title !== scheduledRunName(primaryCron)) return false;
    // The scheduled run-name carries no date, so bind it to today's cycle by its UTC creation date.
    return utcDateString(run.created_at) === scheduleDate;
  }
  if (event === "workflow_dispatch") {
    return (
      title === dispatchRunName(region, recoveryDispatchId(region, businessDate)) ||
      title === dispatchRunName(region, watchdogDispatchId(region, businessDate))
    );
  }
  return false;
}

// Classify a matched run: 'active' (in-flight or already succeeded -> the cycle is covered) vs
// 'finished-unsuccessful' (a run started and did not succeed -> report, but NEVER auto-retry).
export function classifyRun(run) {
  const status = String((run && run.status) || "");
  if (IN_FLIGHT_STATUSES.has(status)) return "active";
  if (status === "completed" && String(run.conclusion || "") === "success") return "active";
  return "finished-unsuccessful";
}

// Validate the raw runs-list API payload. Returns { ok, runs, reason }. FAIL CLOSED: a missing, malformed, or
// TRUNCATED (paginated beyond what we fetched) response is ok:false -- it must NEVER be interpreted as "no run".
export function validateRunsResponse(json) {
  if (!json || typeof json !== "object") return { ok: false, runs: [], reason: "response-not-object" };
  const runs = json.workflow_runs;
  if (!Array.isArray(runs)) return { ok: false, runs: [], reason: "workflow_runs-not-array" };
  if (typeof json.total_count !== "number") return { ok: false, runs: [], reason: "total_count-missing" };
  if (json.total_count > runs.length) return { ok: false, runs: [], reason: "response-truncated" };
  for (const run of runs) {
    if (!run || typeof run !== "object") return { ok: false, runs: [], reason: "run-not-object" };
    if (run.event == null || run.status == null || run.created_at == null) {
      return { ok: false, runs: [], reason: "run-missing-fields" };
    }
    if (run.display_title == null && run.name == null) return { ok: false, runs: [], reason: "run-missing-title" };
  }
  return { ok: true, runs, reason: "ok" };
}

// The decision for ONE region at instant `now`.
//   apiOk=false                 -> fail-closed (never dispatch on an unusable lookup)
//   phase before-grace          -> skip (before-grace)
//   phase after-window          -> skip (window-closed)
//   in-window + no matching run -> dispatch (recovery/<region>/<business-date>)
//   in-window + matching active -> skip (run-exists)  [queued | in_progress | success]
//   in-window + only failed     -> report-failed (NO dispatch, honest diagnostic)
export function decideRecoveryForRegion({ region, now, apiOk, runs }) {
  const ph = recoveryPhase(region, now);
  const base = {
    region,
    primaryCron: ph.primaryCron,
    expectedUtc: ph.expectedUtc.toISOString(),
    graceStartUtc: ph.graceStartUtc.toISOString(),
    windowEndUtc: ph.windowEndUtc.toISOString(),
    scheduleDate: ph.scheduleDate,
    businessDate: ph.businessDate,
    phase: ph.phase,
    dispatchId: recoveryDispatchId(region, ph.businessDate),
    durableCycleKey: durableCycleKey(region, ph.businessDate),
  };
  if (ph.phase === "before-grace") return { ...base, action: "skip", reason: "before-grace", matchedCount: 0 };
  if (ph.phase === "after-window") return { ...base, action: "skip", reason: "window-closed", matchedCount: 0 };
  // in-window
  if (!apiOk) return { ...base, action: "fail-closed", reason: "api-unavailable", matchedCount: 0 };
  const list = Array.isArray(runs) ? runs : [];
  const matched = list.filter((run) =>
    isMatchingRun(run, { region, primaryCron: ph.primaryCron, scheduleDate: ph.scheduleDate, businessDate: ph.businessDate }),
  );
  if (matched.length === 0) {
    return { ...base, action: "dispatch", reason: "no-run-created", matchedCount: 0 };
  }
  const anyActive = matched.some((run) => classifyRun(run) === "active");
  if (anyActive) {
    return { ...base, action: "skip", reason: "run-exists", matchedCount: matched.length };
  }
  return {
    ...base,
    action: "report-failed",
    reason: "run-failed-no-retry",
    matchedCount: matched.length,
    failedRunIds: matched.map((r) => r && r.id).filter((x) => x != null),
  };
}

// Decide for EVERY scheduled region at instant `now`. At most one region is ever in-window (the three windows are
// disjoint), so at most one decision can be a dispatch/report-failed; the rest skip. apiOk applies to all.
export function decideRecovery({ now, apiOk, runs }) {
  return SCHEDULED_REGIONS.map((region) => decideRecoveryForRegion({ region, now, apiOk, runs }));
}
