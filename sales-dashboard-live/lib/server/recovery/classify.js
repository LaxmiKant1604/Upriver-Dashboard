// Publication recovery worker -- PURE classification of the existing reconcilers' per-(account, report) states
// (saved-data-reconciler.js PUBLICATION_STATE / RECONCILE_STATUS, as emitted by the CLIs' --emit-targets line) into
// the worker's durable outcomes. A job is VERIFIED only when the reconciler's own exact publication binding (latest
// promotable job + shadow + live identity + publisher read-back + payload equality) reports PUBLICATION_NOT_REQUIRED;
// a green process exit, a READBACK_VERIFIED from the publishing run, or a shadow snapshot is never sufficient on its own.

export const STATES = Object.freeze({
  CURRENT: "PUBLICATION_NOT_REQUIRED",
  STALE: "STALE",
  PROVENANCE: "DEFERRED_PROVENANCE",
  DEPENDENCY: "DEFERRED_DEPENDENCY",
  PUBLISHED: "PUBLISHED_LIVE",
  READBACK_VERIFIED: "READBACK_VERIFIED",
  FAILED_DERIVE: "FAILED_DERIVE",
  FAILED_PUBLISH: "FAILED_PUBLISH",
  FAILED_READBACK: "FAILED_READBACK",
});

// Worker classes (stored in jobs.last_class / state.last_class and surfaced on the status panel).
export const CLASSES = Object.freeze({
  CURRENT: "current",                         // proven current by the exact binding
  STALE: "stale",                             // saved evidence not yet reflected in the live report
  MISSING_EVIDENCE: "missing-evidence",       // upstream saved evidence absent/ineligible -> reported, NEVER fetched
  DEPENDENCY: "dependency-deferral",          // legitimately not publishable yet (provisional/unavailable/upstream report)
  CONTENTION: "contention",                   // global lease / controls held by another publisher -> retry later, no attempt
  NOT_ATTEMPTED: "not-attempted",             // the reconciler reserved its deadline for cleanup and never tried it
  RUN_FAILED: "run-failed",                   // the whole reconciler run failed before any per-account result
  TIMEOUT: "timeout",                         // deadline/child timeout -> retry with backoff
  TRANSPORT: "transport",                     // transient I/O/process failure -> retry with backoff
  READBACK_MISMATCH: "readback-mismatch",     // publish reported ok but the binding still disagrees -> bounded retry
  SUPERSEDED_NEWER_LIVE: "superseded-newer-live", // another writer holds a newer live row -> permanent for this evidence
  TERMINAL_CYCLE: "terminal-cycle-stuck",     // revision's dedicated cycle is terminal -> cannot converge for this revision
  INTEGRITY: "permanent-integrity",           // malformed/conflicting evidence -> dead-letter, never loop
  ZERO_EXPORT_VIOLATION: "zero-export-violation", // a reconciler reported a DataDoe create/token -> dead + family tripwire
  UNKNOWN: "unclassified",
});

const S = (v) => (v == null ? "" : String(v));

/** Reduce one account entry of a TARGETS line to a single verdict over the family's report keys. */
export function accountVerdict(account, reportKeys) {
  const reports = (account && account.reports) || {};
  const rows = (reportKeys && reportKeys.length ? reportKeys : Object.keys(reports)).map((rk) => ({ rk, s: S(reports[rk] && reports[rk].s), r: reports[rk] ? reports[rk].r : null }));
  const missing = rows.filter((x) => !x.s);
  if (!rows.length || missing.length) return { cls: CLASSES.UNKNOWN, reason: missing.length ? "report-missing-from-targets:" + missing.map((x) => x.rk).join(",") : "no-reports", rows };
  const first = (pred) => rows.find(pred);
  if (rows.every((x) => x.s === STATES.CURRENT)) return { cls: CLASSES.CURRENT, reason: null, rows };
  const prov = first((x) => x.s === STATES.PROVENANCE);
  if (prov) return { cls: CLASSES.MISSING_EVIDENCE, reason: prov.r || "provenance-ineligible", rows };
  const stale = first((x) => x.s === STATES.STALE);
  if (stale) return { cls: CLASSES.STALE, reason: stale.r || "stale", rows };
  const failed = first((x) => x.s === STATES.FAILED_DERIVE || x.s === STATES.FAILED_PUBLISH || x.s === STATES.FAILED_READBACK);
  if (failed) return { ...classifyFailure(failed.s, failed.r), rows };
  const dep = first((x) => x.s === STATES.DEPENDENCY);
  if (dep) return { ...classifyDeferral(dep.r), rows };
  if (rows.every((x) => x.s === STATES.CURRENT || x.s === STATES.PUBLISHED || x.s === STATES.READBACK_VERIFIED)) return { cls: "published-unverified", reason: null, rows };
  return { cls: CLASSES.UNKNOWN, reason: "unrecognized-state:" + rows.map((x) => x.s).join(","), rows };
}

/** DEFERRED_DEPENDENCY reason code -> class (contention is retried quickly WITHOUT burning an attempt). */
export function classifyDeferral(reason) {
  const r = S(reason);
  // NEWER_LIVE (saved-data-reconciler RETRYABLE_STATUS -> DEFERRED_DEPENDENCY; reasons publish-newer-live /
  // shadow-newer-live): the live row is STRICTLY newer than anything this evidence can publish -- the evidence is
  // superseded, not awaiting publication. Terminal for this token (a new token opens a new job).
  if (/newer-live|NEWER_LIVE/i.test(r)) return { cls: CLASSES.SUPERSEDED_NEWER_LIVE, reason: r };
  if (/^controls-not-opened|CONTROL_LEASE|lease-lost|leaseLost|control-apply|CONTROL_PLANE/i.test(r)) return { cls: CLASSES.CONTENTION, reason: r || "contention" };
  if (/^deadline-cleanup-reserved/i.test(r)) return { cls: CLASSES.NOT_ATTEMPTED, reason: r };
  if (/^deadline/i.test(r)) return { cls: CLASSES.TIMEOUT, reason: r };
  if (/^cycle-not-running/i.test(r)) return { cls: CLASSES.TERMINAL_CYCLE, reason: r };
  return { cls: CLASSES.DEPENDENCY, reason: r || "deferred-dependency" };
}

/** FAILED_* state + reason code -> class. */
export function classifyFailure(state, reason) {
  const r = S(reason);
  if (/newer-live|NEWER_LIVE/i.test(r)) return { cls: CLASSES.SUPERSEDED_NEWER_LIVE, reason: r };
  if (/^cycle-not-running/i.test(r)) return { cls: CLASSES.TERMINAL_CYCLE, reason: r };
  if (/malformed|conflict|integrity|dangling|mismatch|invalid|payload-unreadable|not-d1|corrupt/i.test(r)) return { cls: CLASSES.INTEGRITY, reason: r || state };
  if (state === STATES.FAILED_READBACK || /readback/i.test(r)) return { cls: CLASSES.READBACK_MISMATCH, reason: r || state };
  if (/threw|timeout|ETIMEDOUT|ECONN|EAI_AGAIN|fetch|network|socket|5\d\d|429/i.test(r)) return { cls: CLASSES.TRANSPORT, reason: r || state };
  return { cls: CLASSES.TRANSPORT, reason: r || state }; // unknown failures retry, bounded by max attempts
}

/**
 * Map a class to the durable finish outcome + backoff (seconds). `attempt` is the job's executed-attempt count so far.
 * Exponential backoff with a cap; contention/dependency/missing-evidence never consume an attempt.
 */
export function outcomeFor(cls, { attempt = 0, baseBackoff = 60, maxBackoff = 3600 } = {}) {
  const exp = Math.min(maxBackoff, baseBackoff * Math.pow(2, Math.max(0, attempt)));
  switch (cls) {
    case CLASSES.CURRENT: return { outcome: "verified", backoff: 0 };
    case CLASSES.CONTENTION: case CLASSES.NOT_ATTEMPTED: return { outcome: "deferred", backoff: Math.min(maxBackoff, 120) };
    case CLASSES.DEPENDENCY: return { outcome: "deferred", backoff: Math.min(maxBackoff, 900) };
    case CLASSES.MISSING_EVIDENCE: return { outcome: "deferred", backoff: Math.min(maxBackoff, 1800) };
    case CLASSES.TIMEOUT: case CLASSES.TRANSPORT: case CLASSES.READBACK_MISMATCH: case CLASSES.RUN_FAILED: case CLASSES.UNKNOWN: case "published-unverified":
      return { outcome: "retry", backoff: exp };
    case CLASSES.SUPERSEDED_NEWER_LIVE: case CLASSES.TERMINAL_CYCLE: case CLASSES.INTEGRITY: case CLASSES.ZERO_EXPORT_VIOLATION:
      return { outcome: "dead", backoff: 0 };
    case CLASSES.STALE: return { outcome: "retry", backoff: exp }; // still stale after a publish attempt
    default: return { outcome: "retry", backoff: exp };
  }
}

/**
 * Classify a finished child run (process level) before looking at per-account states. Returns null when the run is
 * well-formed (per-account classification applies), else a class for EVERY account in the batch.
 */
export function classifyRun(run) {
  if (!run) return { cls: CLASSES.TRANSPORT, reason: "no-run" };
  if (run.spawnError) return { cls: CLASSES.TRANSPORT, reason: "spawn-failed" };
  if (run.timedOut) return { cls: CLASSES.TIMEOUT, reason: "child-hard-timeout" };
  const t = run.targets;
  const res = run.result;
  if ((res && (Number(res.dataDoeCreates) > 0 || Number(res.dataDoeTokens) > 0)) || (t && (Number(t.dataDoeCreates) > 0 || Number(t.dataDoeTokens) > 0))) {
    return { cls: CLASSES.ZERO_EXPORT_VIOLATION, reason: "reconciler-reported-datadoe-spend" };
  }
  if (!t) return { cls: CLASSES.TRANSPORT, reason: res ? "no-targets-line:" + S(res.code || res.outcome) : "no-result-line:exit-" + S(run.exitCode) };
  // A whole-run failure (saved-data-reconciler fail(): outcome "failed", a typed code, perAccount []) is NOT "every
  // account missing": classify it once, by its code (integrity codes dead-letter; everything else retries, bounded).
  if (S(t.outcome) === "failed") {
    const code = S(t.code || (res && res.code)) || "failed";
    const f = classifyFailure("FAILED_RUN", code);
    return { cls: f.cls === CLASSES.INTEGRITY ? CLASSES.INTEGRITY : CLASSES.RUN_FAILED, reason: "run-failed:" + code };
  }
  return null;
}

/** The reconciler reported that its own control cleanup did not complete (the run token must be cleaned up). */
export function cleanupUnresolved(run) {
  if (!run) return false;
  return (run.targets && run.targets.controlCleanupUnresolved === true) || S(run.result && run.result.code) === "CONTROL_CLEANUP_UNRESOLVED";
}
