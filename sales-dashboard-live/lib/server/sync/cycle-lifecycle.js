// Scheduler v2 -- cycle lifecycle state table (PURE; no I/O).
//
// The canonical dispatcher (runSchedulerV2Shadow) owns cycle FINALIZATION; a source-family driver must never
// finalize the shared (bucket, cycle_date) cycle early. This module is the single, documented source of truth
// for the lifecycle decision, and its JS is the exact reference the guarded `finalize_sync_cycle` RPC mirrors
// (see supabase/migrations/20260815_sync_cycle_finalize.sql -- PREPARED, UNAPPLIED). Pure functions here are
// fully offline-testable.
//
// ===================== CYCLE LIFECYCLE STATE TABLE =====================
// A cycle row (public.sync_cycles) moves: pending --claim_sync_cycle--> running --finalize--> terminal.
//
// | # | run outcome (this invocation)                              | cycle after this run        | finished_at |
// |---|------------------------------------------------------------|-----------------------------|-------------|
// | 1 | FULLY DRAINED, no failures (all source + report succeeded) | succeeded                   | set         |
// | 2 | FULLY DRAINED, some source/report failed or blocked        | partial                     | set         |
// | 3 | FULLY DRAINED, nothing succeeded (all failed/blocked)      | failed                      | set         |
// | 4 | NOT drained: pending / maxJobs-truncated                   | running (resumable)         | null        |
// | 5 | NOT drained: a resumable deferral (poll-pending/deadline)  | running (resumable)         | null        |
// | 6 | NOT drained: wall-clock deadline / budget stop             | running (resumable)         | null        |
// | 7 | MANUAL SUBSET drained, but the SHARED cycle still has open  | running (NOT closed) --      | null        |
// |   |  source/report work from another owner/report              |  guard-rejected finalize    |             |
// | 8 | CONCURRENT continuation appended open work before finalize | running (finalize rejected) | null        |
// | 9 | already TERMINAL (idempotent replay)                       | unchanged terminal          | unchanged   |
//
// Rows 1-3 are decided by `terminalCycleStatus`. Rows 4-6: the dispatcher does NOT attempt finalization when
// its run did not drain (drained=false).
//
// SCOPE SEMANTICS (the manual-subset fix): auto-finalization is attempted ONLY for a COMPLETE SCHEDULED scope.
// A scheduled run plans + upserts its ENTIRE ready+scheduled scope before draining, so "no open child jobs" is
// a genuine complete-cycle signal. A MANUAL run is a partial subset -- it may plan only some reports, and a
// later manual run for a DIFFERENT report can legitimately append to the same (bucket, cycleDate) -- so a
// manual run NEVER auto-finalizes (row 7); its cycle stays `running` and is closed only by an explicit reviewed
// operation (the direct `finalize_sync_cycle` call, e.g. SCHEDULER_V2_ROLLOUT.md Appendix N). This is why the
// Gate 5 canary (a manual run) legitimately left its cycle `running`.
//
// The guarded finalize (finalize_sync_cycle RPC -- 20260815_sync_cycle_finalize.sql, PREPARED/UNAPPLIED)
// atomically re-checks the WHOLE cycle under a FOR UPDATE lock and returns a TOTAL, TYPED disposition (never an
// ambiguous null): `finalized` (running->terminal now, rows 1-3), `already-terminal` (idempotent replay, row 9),
// `open-work` (still-open source/report jobs from a concurrent continuation/scope -> continuation required, row
// 8), `not-found`, or `invalid-status`. The append-after-terminal trigger additionally forbids changing a child
// row's cycle_id and blocks any insert/update whose parent cycle is terminal -- so a row can never be added to,
// altered in, or moved out of a terminal cycle.
// ======================================================================

// A source job is OPEN (not yet terminal for the cycle) while it is pending or attempted (an attempted job is
// mid create-export/poll/download and is resumable). succeeded / failed / skipped are terminal.
export function isSourceJobOpen(job) {
  const s = job && (job.fetch_status ?? job.fetchStatus);
  return s === "pending" || s === "attempted";
}

// A report job is FINISHED (terminal for the cycle) when: it is terminally blocked; OR it derived AND saved;
// OR its derive failed/skipped (not retried in-cycle); OR its save failed (a NEW cycle re-derives). Anything
// else (pending / ready-not-yet-derived / derive running) is still OPEN. Mirrors report-worker.reportJobFinished.
export function isReportJobFinished(job) {
  const fetchS = job && (job.fetch_status ?? job.fetchStatus);
  const derive = job && (job.derive_status ?? job.deriveStatus);
  const save = job && (job.save_status ?? job.saveStatus);
  if (fetchS === "blocked") return true;
  if (derive === "succeeded" && save === "succeeded") return true;
  if (derive === "failed" || derive === "skipped") return true;
  if (save === "failed") return true;
  return false;
}
export function isReportJobOpen(job) { return !isReportJobFinished(job); }

// Whether a report job produced a fresh saved snapshot this cycle (a "success" for the counters).
export function isReportJobSuccess(job) {
  const derive = job && (job.derive_status ?? job.deriveStatus);
  const save = job && (job.save_status ?? job.saveStatus);
  return derive === "succeeded" && save === "succeeded";
}

// Authoritative terminal status from the final counters (rows 1-3 of the table). `succeeded` when NOTHING
// failed; `failed` when NOTHING succeeded; `partial` otherwise. Blocked/failed report jobs count as failures
// for this classification; skipped (claimed by a concurrent invocation) counts as neither.
export function terminalCycleStatus({ sourceSucceeded = 0, sourceFailed = 0, reportSucceeded = 0, reportFailed = 0 } = {}) {
  const anyFail = (sourceFailed || 0) > 0 || (reportFailed || 0) > 0;
  const anyOk = (sourceSucceeded || 0) > 0 || (reportSucceeded || 0) > 0;
  if (!anyFail) return "succeeded";
  if (!anyOk) return "failed";
  return "partial";
}

// Compute authoritative source + report counters from the canonical job rows of a cycle (what the RPC persists).
// source_failed counts fetch_status='failed'; report_failed counts finished-but-not-success report jobs
// (blocked / derive-failed / derive-skipped / save-failed).
export function computeCycleCounters(sourceJobs = [], reportJobs = []) {
  const src = sourceJobs || [];
  const rep = reportJobs || [];
  const sourceSucceeded = src.filter((j) => (j.fetch_status ?? j.fetchStatus) === "succeeded").length;
  const sourceFailed = src.filter((j) => (j.fetch_status ?? j.fetchStatus) === "failed").length;
  const reportSucceeded = rep.filter(isReportJobSuccess).length;
  const reportFailed = rep.filter((j) => isReportJobFinished(j) && !isReportJobSuccess(j)).length;
  return {
    sourceTotal: src.length, sourceSucceeded, sourceFailed,
    reportTotal: rep.length, reportSucceeded, reportFailed,
  };
}

// Is the WHOLE cycle drained -- i.e. safe to finalize? True only when NO source job is open and NO report job
// is open. This is the exact condition the guarded finalize RPC re-checks atomically (rows 7-9).
export function cycleFullyDrained(sourceJobs = [], reportJobs = []) {
  return !(sourceJobs || []).some(isSourceJobOpen) && !(reportJobs || []).some(isReportJobOpen);
}
