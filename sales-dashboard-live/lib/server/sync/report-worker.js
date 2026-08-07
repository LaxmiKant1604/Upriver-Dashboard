// Scheduler v2 Phase 1d -- checkpointable, idempotent report-derivation worker (SHADOW MODE).
//
// The report half of a cycle: for each planned report job, gate on its REQUIRED saved source
// rows, claim derive once, derive the snapshot PURELY from those rows (report-derivation.js),
// validate, then save a versioned SHADOW snapshot. It makes ZERO DataDoe exports -- it imports
// only pure modules (planner.js, report-derivation.js) and reaches all I/O through injected
// callbacks (store, sourceRows, saveSnapshot). Not wired to any route/cron; does not replace
// Scheduler v1 and does not change what pages read.
//
// Separated accounting (mirrors sync_report_jobs): fetch (are required deps saved?),
// derive (did the pure calc run?), validate (is the payload real?), and save (did the shadow
// snapshot persist?) are DISTINCT stages. A Supabase save failure is never reported as a
// DataDoe fetch failure. Last-known-good is preserved on every failure (a failed report never
// saves an empty/partial/invalid snapshot, and one report's failure never blocks another).
//
// Injected `store` (report side; may be the same object as the source store):
//   listSourceJobs(cycleId) -> [{ request_hash, fetch_status, ... }]   (source dep statuses)
//   upsertReportJob({ cycleId, bucket, reportKey, reportVersion, accountId, connectionId, dependsOn }) -> void
//   listReportJobs(cycleId) -> [{ report_key, account_id, fetch_status, derive_status, save_status, validated, depends_on }]
//   claimReportDerive(cycleId, reportKey, accountId) -> boolean   (guarded pending -> running)
//   recordReportBlocked({ cycleId, reportKey, accountId, reason }) -> void
//   recordReportFailure({ cycleId, reportKey, accountId, stage, code, message, terminal, durationMs }) -> void
//   recordReportSuccess({ cycleId, reportKey, accountId, latestDataDate, rowCount, payloadBytes, snapshotParamsHash, durationMs }) -> void
// Injected `sourceRows(requestHash)` -> { rows: array } | null   (cache-only; getSourceExportCache)
// Injected `saveSnapshot({ reportKey, accountId, params, payload, payloadBytes, sourceRefreshedAt })`
//   -> { paramsHash } (persists the SHADOW snapshot; throws on save failure).

import { reportFetchGate } from "./planner.js";
import { REPORT_DERIVATIONS, deriveReportSnapshot, shadowSnapshotKey } from "./report-derivation.js";

function approxBytes(payload) {
  try { return Buffer.byteLength(JSON.stringify(payload ?? null)); } catch { return 0; }
}

// A report job is finished when it derived AND saved (or was terminally blocked). Finished
// jobs are never re-derived (idempotent across repeated worker invocations).
function reportFinished(jobRow) {
  const derive = jobRow.derive_status ?? jobRow.deriveStatus ?? "pending";
  const save = jobRow.save_status ?? jobRow.saveStatus ?? "pending";
  if (derive === "succeeded" && save === "succeeded") return true;
  if (derive === "failed" || derive === "skipped") return true; // not retried in-cycle
  if (save === "failed") return true; // save failed this cycle; a NEW cycle re-derives
  return false;
}

async function runOneReport({ store, cycleId, sourceRows, saveSnapshot, planned, statusByHash, clock }) {
  const { reportKey, accountId } = planned;
  const started = clock();
  const entry = REPORT_DERIVATIONS[reportKey];
  const fail = async (stage, code, message, terminal = false) => {
    await store.recordReportFailure({ cycleId, reportKey, accountId, stage, code, message, terminal, durationMs: clock() - started });
    return { reportKey, accountId, status: "failed", stage, code };
  };

  const required = planned.sources.filter((s) => !s.optional);
  const requiredHashes = required.map((s) => s.requestHash);

  // 1) FETCH gate: are all REQUIRED source deps saved? (Optional/degraded deps never block.)
  const gate = reportFetchGate({ dependsOn: requiredHashes }, statusByHash);
  if (gate === "pending") {
    return { reportKey, accountId, status: "pending" };
  }
  if (gate === "blocked") {
    // A required source failed/was skipped: block THIS report only; preserve last-known-good.
    await store.recordReportBlocked({ cycleId, reportKey, accountId, reason: "required source failed or skipped" });
    return { reportKey, accountId, status: "blocked" };
  }

  // 2) Claim derive exactly once (guarded pending -> running). Lose it => another worker owns it.
  const won = await store.claimReportDerive(cycleId, reportKey, accountId);
  if (!won) return { reportKey, accountId, status: "skipped", reason: "derive already claimed" };

  // 3) Build the cache-only `sources` map. available:true REQUIRES a validated saved array;
  //    a miss/malformed/failed source is available:false and NEVER coerced to [].
  const sources = {};
  for (const s of planned.sources) {
    const jobStatus = statusByHash[s.requestHash];
    let rows = null;
    if (jobStatus === "succeeded") {
      let payload = null;
      try { payload = await sourceRows(s.requestHash); } catch (_e) { payload = null; }
      if (payload && Array.isArray(payload.rows)) rows = payload.rows;
    }
    sources[s.requestKey] = {
      available: Array.isArray(rows),
      rows,
      disabled: jobStatus === "failed" && !!s.disabledPolicy,
      disabledPolicy: s.disabledPolicy || null,
      reason: rows == null ? `source "${s.requestKey}" not a validated saved payload (status=${jobStatus || "missing"})` : null,
    };
  }

  // 4) Derive (pure). Never fabricate on unavailable/blocked/invalid/not-implemented.
  const result = deriveReportSnapshot({ reportKey, sources, context: planned.context || {} });
  if (result.status !== "derived") {
    if (result.status === "blocked") {
      await store.recordReportBlocked({ cycleId, reportKey, accountId, reason: result.reason });
      return { reportKey, accountId, status: "blocked" };
    }
    if (result.status === "unavailable" || result.status === "not-implemented") {
      // Dependencies not (yet) derivable: record derive-pending as a non-terminal skip so the
      // previous snapshot survives and a later cycle can retry. Not a hard failure.
      await store.recordReportFailure({ cycleId, reportKey, accountId, stage: result.errorStage || "derive", code: result.status === "not-implemented" ? "DERIVE_NOT_IMPLEMENTED" : "SOURCE_UNAVAILABLE", message: result.reason, terminal: false, durationMs: clock() - started });
      return { reportKey, accountId, status: result.status };
    }
    return fail(result.errorStage || "derive", "DERIVE_INVALID", result.reason || "derivation failed", true);
  }

  // 5) SAVE the shadow snapshot. A save failure is a SEPARATE stage from derive/validate and
  //    never overwrites the previous good snapshot (save throws before any pointer moves).
  const payloadBytes = approxBytes(result.payload);
  const params = { reportVersion: entry.snapshotVersion, accountId, ...(planned.context || {}) };
  let saved;
  try {
    saved = await saveSnapshot({
      reportKey: shadowSnapshotKey(reportKey),
      accountId,
      params,
      payload: result.payload,
      payloadBytes,
      sourceRefreshedAt: planned.sourceRefreshedAt || null,
    });
  } catch (error) {
    return fail("save", "SNAPSHOT_SAVE_FAILED", "Saving the shadow snapshot failed; previous snapshot preserved.", false);
  }
  const rowCount = Array.isArray(result.payload && result.payload.rows) ? result.payload.rows.length
    : Array.isArray(result.payload && result.payload.events) ? result.payload.events.length : null;

  // 6) SUCCESS: fetch + derive + validate + save all passed.
  await store.recordReportSuccess({
    cycleId, reportKey, accountId,
    latestDataDate: result.latestDataDate,
    rowCount, payloadBytes,
    snapshotParamsHash: saved && saved.paramsHash ? saved.paramsHash : null,
    durationMs: clock() - started,
  });
  return { reportKey, accountId, status: "succeeded", latestDataDate: result.latestDataDate, rowCount };
}

/**
 * Run (or resume) the report half of ONE cycle for a fixed set of planned report jobs.
 * Idempotent: upserts each report job, derives only ready+unfinished ones, bounded by maxJobs
 * and a wall-clock deadline. Returns progress + per-report outcomes; never a secret.
 */
export async function runReportJobs({
  store, cycleId, sourceRows, saveSnapshot, plannedReports = [],
  clock = () => Date.now(), deadlineMs = Infinity, reserveMs = 3000, maxJobs = Infinity,
}) {
  const progress = { cycleId, planned: 0, processed: 0, succeeded: 0, failed: 0, blocked: 0, skipped: 0, pending: 0, deadlineReached: false, drained: false };
  const outcomes = [];

  // Upsert each planned report job once (idempotent). Derived-only reports own no source
  // deps; their dependsOn is [].
  for (const p of plannedReports) {
    if (!p || !p.reportKey) continue;
    const dependsOn = (p.sources || []).map((s) => s.requestHash);
    await store.upsertReportJob({
      cycleId, bucket: p.bucket, reportKey: p.reportKey, reportVersion: p.reportVersion || (REPORT_DERIVATIONS[p.reportKey] ? REPORT_DERIVATIONS[p.reportKey].snapshotVersion : ""),
      accountId: p.accountId, connectionId: p.connectionId, dependsOn,
    });
  }
  const plannedByKey = new Map(plannedReports.filter((p) => p && p.reportKey).map((p) => [`${p.reportKey}|${p.accountId}`, p]));
  progress.planned = plannedByKey.size;

  // Source dependency statuses for gating.
  const sourceJobs = await store.listSourceJobs(cycleId);
  const statusByHash = {};
  for (const j of sourceJobs) statusByHash[j.request_hash ?? j.requestHash] = j.fetch_status ?? j.fetchStatus;

  const jobRows = await store.listReportJobs(cycleId);
  for (const jobRow of jobRows) {
    const key = `${jobRow.report_key ?? jobRow.reportKey}|${jobRow.account_id ?? jobRow.accountId}`;
    const planned = plannedByKey.get(key);
    if (!planned) continue; // no plan entry this invocation
    if (reportFinished(jobRow)) continue; // idempotent: never re-derive a finished report
    if (progress.processed >= maxJobs) break;
    if (clock() >= deadlineMs - reserveMs) { progress.deadlineReached = true; break; }
    progress.processed += 1;

    let outcome;
    try {
      outcome = await runOneReport({ store, cycleId, sourceRows, saveSnapshot, planned, statusByHash, clock });
    } catch (error) {
      // Failure isolation: one report throwing never blocks the others.
      await store.recordReportFailure({ cycleId, reportKey: planned.reportKey, accountId: planned.accountId, stage: "derive", code: "DERIVE_CRASH", message: "Report derivation crashed.", terminal: true, durationMs: 0 });
      outcome = { reportKey: planned.reportKey, accountId: planned.accountId, status: "failed", stage: "derive" };
    }
    outcomes.push(outcome);
    if (outcome.status === "succeeded") progress.succeeded += 1;
    else if (outcome.status === "blocked") progress.blocked += 1;
    else if (outcome.status === "failed") progress.failed += 1;
    else if (outcome.status === "skipped") progress.skipped += 1;
    else progress.pending += 1;
  }

  const finalJobs = await store.listReportJobs(cycleId);
  const unfinished = finalJobs.some((j) => !reportFinished(j) && plannedByKey.has(`${j.report_key ?? j.reportKey}|${j.account_id ?? j.accountId}`));
  progress.drained = !unfinished && !progress.deadlineReached;
  return { ...progress, outcomes };
}
