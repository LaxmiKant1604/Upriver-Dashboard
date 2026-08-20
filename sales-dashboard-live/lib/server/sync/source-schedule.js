// Scheduler v2 -- INERT SOURCE-FIRST SCHEDULE (Phase 6; pure decision layer, ZERO I/O, NOTHING enabled).
//
// The reviewed source-first cadence, prepared but NOT wired: this module registers NO cron, creates NO
// route, starts NO timer (there is no timer API call anywhere in this file), and every source's
// schedule_enabled defaults FALSE durably (source_controls; a reviewed durable enablement is required
// before plannedScheduledInvocation can ever answer "launch"). It only DESCRIBES, from injected durable
// state and an injected clock, whether a scheduled bucket run would launch and with which
// marketplace-local asOf.
//
//   - Non-US: daily 07:30 IST = 02:00 UTC.  US: daily 04:00 PM IST = 10:30 UTC.
//   - Each marketplace contributes its LATEST COMPLETED LOCAL DAY (standard-time offsets, deliberately
//     conservative under DST: the computed local time is never AHEAD of the real local time, so a
//     not-yet-finished local day can never be treated as complete). A bucket run uses the MINIMUM across
//     its marketplaces, so every account's day is complete.
//   - A launch waits for source/batch COMPLETION plus an at-least-one-minute completion-anchored cooldown
//     (never a blind fixed one-minute offset): a run whose previous attempt finished under a minute ago is
//     "cooldown"; a still-running one is "overlap" (no overlapping runs for the same organization/source/
//     bucket -- the (bucket, cycle_date) cycle is the org-wide mutual-exclusion key underneath).
//   - Polling GETs are NOT create-exports and keep the transport's existing five-second policy (pinned by
//     test against lib/server/datadoe.js); failed/attempted request hashes are never automatically
//     recreated (the engine's one-attempt claim + skip-terminal, unchanged by this module).

export const SOURCE_SYNC_SCHEDULE_UTC = Object.freeze({ "non-us": "02:00", us: "10:30" });
export const SOURCE_SYNC_SCHEDULE_IST = Object.freeze({ "non-us": "07:30", us: "16:00" });
export const SOURCE_SYNC_SCHEDULE_CRON = Object.freeze({ "non-us": "0 2 * * *", us: "30 10 * * *" });
export const SCHEDULE_COOLDOWN_MS = 60_000;

// STANDARD-time (winter) UTC offsets in minutes per marketplace country. Standard offsets are <= the DST
// offset everywhere here, so the computed local clock never runs AHEAD of the real one -- the "latest
// completed local day" can only be conservative (a day is never declared complete early). US/CA pin to
// Pacific (the westernmost seller-central zone), again the conservative floor.
export const MARKETPLACE_UTC_OFFSET_MINUTES = Object.freeze({
  IN: 330, US: -480, CA: -480, UK: 0, GB: 0, DE: 60, IT: 60, ES: 60, FR: 60, NL: 60, BE: 60, PL: 60, AU: 600,
});

const DAY_MS = 86_400_000;
const pad2 = (n) => String(n).padStart(2, "0");
const utcDateStr = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};

/**
 * The latest COMPLETED local calendar day for one marketplace at `nowUtcMs`: the marketplace's local date
 * minus one day (today is by definition incomplete). An unknown marketplace fails closed -- a schedule must
 * never guess a timezone.
 */
export function latestCompletedLocalDay(nowUtcMs, marketplaceCountry) {
  const offset = MARKETPLACE_UTC_OFFSET_MINUTES[String(marketplaceCountry || "").toUpperCase()];
  if (offset === undefined) {
    throw new Error(`latestCompletedLocalDay: unknown marketplace "${marketplaceCountry}" (no reviewed timezone offset; fail closed).`);
  }
  return utcDateStr(nowUtcMs + offset * 60_000 - DAY_MS);
}

/**
 * One conservative asOf for a whole bucket run: the MINIMUM latest-completed-local-day across the bucket's
 * marketplaces, so the day is complete for EVERY account in the run. Returns { asOf, perMarketplace }.
 */
export function bucketAsOf(nowUtcMs, marketplaceCountries) {
  const countries = [...new Set((marketplaceCountries || []).map((c) => String(c || "").toUpperCase()).filter(Boolean))];
  if (!countries.length) throw new Error("bucketAsOf requires the bucket's marketplace countries (fail closed).");
  const perMarketplace = Object.fromEntries(countries.map((c) => [c, latestCompletedLocalDay(nowUtcMs, c)]));
  const asOf = Object.values(perMarketplace).sort()[0];
  return { asOf, perMarketplace };
}

// The next UTC occurrence of the bucket's scheduled time at/after `nowUtcMs`.
export function nextScheduledRunUtc(bucket, nowUtcMs) {
  const time = SOURCE_SYNC_SCHEDULE_UTC[bucket];
  if (!time) throw new Error(`nextScheduledRunUtc: unknown bucket "${bucket}" (fail closed).`);
  const [hh, mm] = time.split(":").map(Number);
  const today = new Date(nowUtcMs);
  const candidate = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), hh, mm, 0, 0);
  return nowUtcMs <= candidate ? candidate : candidate + DAY_MS;
}

/**
 * DESCRIBE whether a scheduled bucket run would launch at `nowUtcMs` -- pure decision, launches nothing.
 * Inputs are the durable operator state (injected, never fetched here):
 *   controls    : source_controls rows (schedule_enabled defaults FALSE for every source);
 *   runStatuses : source_run_status rows for this bucket;
 *   marketplaceCountries : the bucket's marketplaces (for the marketplace-local asOf).
 * Decision chain (first match wins; every negative is typed):
 *   schedule-disabled   -- no source is durably schedule_enabled (the default state: the schedule is INERT);
 *   not-due             -- before today's scheduled UTC time;
 *   overlap             -- an enabled source in this bucket is still `running` (no overlapping runs);
 *   already-ran-today   -- every enabled source COMPLETED (succeeded) at/after today's scheduled time; a
 *                          failed/partial attempt today is NOT completion -- the run may need a bounded
 *                          continuation, which the cooldown below paces (the one-attempt claim still
 *                          guarantees no failed/attempted hash is ever recreated);
 *   cooldown            -- the latest completion/attempt is under SCHEDULE_COOLDOWN_MS old
 *                          (completion-anchored, never a blind offset);
 *   launch              -- with the conservative bucket asOf and the enabled source list.
 */
export function plannedScheduledInvocation({ bucket, nowUtcMs, marketplaceCountries, controls = [], runStatuses = [] } = {}) {
  if (bucket !== "us" && bucket !== "non-us") throw new Error(`plannedScheduledInvocation requires bucket 'us'|'non-us' (got "${bucket}").`);
  if (!Number.isFinite(nowUtcMs)) throw new Error("plannedScheduledInvocation requires a finite nowUtcMs (fail closed).");

  const enabledSources = (controls || [])
    .filter((r) => r && r.schedule_enabled === true && r.paused !== true)
    .map((r) => r.source_key);
  if (!enabledSources.length) {
    return { launch: false, reason: "schedule-disabled", bucket, enabledSources: [] };
  }

  const dueAtMs = (() => {
    const [hh, mm] = SOURCE_SYNC_SCHEDULE_UTC[bucket].split(":").map(Number);
    const d = new Date(nowUtcMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm, 0, 0);
  })();
  if (nowUtcMs < dueAtMs) {
    return { launch: false, reason: "not-due", bucket, dueAtMs, enabledSources };
  }

  const bucketRows = (runStatuses || []).filter((r) => r && r.bucket === bucket && enabledSources.includes(r.source_key));
  if (bucketRows.some((r) => r.last_status === "running")) {
    return { launch: false, reason: "overlap", bucket, enabledSources };
  }

  const completedToday = bucketRows.filter((r) => r.last_status === "succeeded"
    && r.last_success_at && Date.parse(r.last_success_at) >= dueAtMs);
  if (enabledSources.every((k) => completedToday.some((r) => r.source_key === k))) {
    return { launch: false, reason: "already-ran-today", bucket, enabledSources };
  }

  const completions = bucketRows
    .map((r) => Math.max(Date.parse(r.last_success_at || "") || 0, Date.parse(r.last_attempt_at || "") || 0))
    .filter((t) => t > 0);
  const latestCompletion = completions.length ? Math.max(...completions) : 0;
  if (latestCompletion && nowUtcMs - latestCompletion < SCHEDULE_COOLDOWN_MS) {
    return { launch: false, reason: "cooldown", bucket, resumeAtMs: latestCompletion + SCHEDULE_COOLDOWN_MS, enabledSources };
  }

  const { asOf, perMarketplace } = bucketAsOf(nowUtcMs, marketplaceCountries);
  return { launch: true, reason: null, bucket, asOf, perMarketplace, enabledSources };
}
