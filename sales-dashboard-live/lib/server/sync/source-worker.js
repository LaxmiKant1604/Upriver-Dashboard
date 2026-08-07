// Scheduler v2 Phase 1c — checkpointable, idempotent source-job worker (SHADOW MODE).
//
// Does NOT replace Scheduler v1 (run-sync.js) and is not wired to any route/cron. It
// executes the source half of one sync cycle as a RESUMABLE state machine: for each
// unique canonical request (request_hash) it makes at most ONE create-export
// (claim_source_export_attempt), persists the export_id BEFORE polling so a crash after
// the POST can resume without a second create, then poll -> download -> validate ->
// save -> success. Fetch / poll / download / validate / persist failures are recorded on
// DISTINCT safe stages and never overwrite last-known-good source data.
//
// The complete canonical job (fetchParams, requestKey, org fingerprint, scope, request
// meta, strict, limit, connection) comes from the PLAN, matched by request_hash; the
// DATABASE remains authoritative for fetch_status, attempted_at, and export_id. The
// production sync_source_jobs row has none of the plan-only fields, so the worker rebuilds
// the full job by merging plan(by hash) with the DB row's authoritative lifecycle state.
//
// All I/O is injected so the worker is deterministic and fully offline-testable:
//   store: {
//     openCycle, claimCycle, getCycle, upsertSourceJob, listSourceJobs,
//     claimExportAttempt(cycleId, requestHash) -> boolean,
//     recordExportCreated({cycleId, requestHash, exportId}) -> void,  // persist id, keep 'attempted'
//     saveSourceRows({job, rows, payloadBytes, exportId, version})
//        -> objectPath string, OR { objectPath, rows, rowCount, payloadBytes } when a
//           concurrent winner was adopted; throws code "CACHE_CONFLICT" on an un-adoptable
//           concurrent pointer,
//     recordSourceSuccess({...}) -> void,
//     recordSourceFailure({...}) -> void,
//     updateCycleCounts(cycleId, {sourceTotal, sourceSucceeded, sourceFailed}) -> void,
//   }
//   dataDoe: {
//     create(job) -> { exportId, completed? }   // exactly one create-export POST
//     poll(job, exportId) -> void               // waits for COMPLETED (throws on fail/timeout)
//     download(job, exportId) -> rows            // returns the rows array (or throws)
//   }

import { isDataDoeDeadlineError, isSourceDisabledError, withDataDoeDeadline } from "../datadoe.js";

const DEFAULT_RESERVE_MS = 3_000; // stop before the server cap so status/locks persist

function approxPayloadBytes(rows) {
  try { return Buffer.byteLength(JSON.stringify(rows ?? [])); } catch { return 0; }
}

// Map any DataDoe error to a SAFE {code, message, terminal} for the given stage. The
// stored message is a fixed operator string — never the raw error, a URL, an id, or a
// key — so no secret can leak. 4xx client errors are terminal; 5xx / timeouts transient.
export function classifyFetchError(error, stage = "create-export") {
  if (isDataDoeDeadlineError(error)) {
    return { stage, code: "TIMEOUT", message: "DataDoe work deferred at the execution deadline.", terminal: false };
  }
  if (isSourceDisabledError(error)) {
    return { stage, code: "SOURCE_DISABLED", message: "Source is disabled for this organization.", terminal: true };
  }
  const raw = error instanceof Error ? error.message : String(error);
  const matched = raw.match(/\((\d{3})\)/);
  if (matched) {
    const status = Number(matched[1]);
    if (status >= 400 && status <= 599) {
      const terminal = status >= 400 && status < 500;
      return { stage, code: `HTTP_${status}`, message: `DataDoe returned HTTP ${status} for this source.`, terminal };
    }
  }
  if (/timed out/i.test(raw)) {
    return { stage, code: "TIMEOUT", message: "DataDoe export timed out while processing.", terminal: false };
  }
  return { stage, code: "EXPORT_ERROR", message: "DataDoe export failed for this source.", terminal: false };
}

function fetchStatusOf(job) {
  return job.fetch_status ?? job.fetchStatus ?? "pending";
}

// Rebuild the complete canonical job: plan supplies fetch params + policies; the DB row
// is authoritative for lifecycle state (status / attempted_at / export_id / connection).
// No 'primary' default — a missing connection id is left undefined so the adapter fails
// closed rather than silently routing to the primary key.
function mergeJob(meta, jobRow) {
  const hash = jobRow.request_hash ?? jobRow.requestHash;
  return {
    ...meta,
    requestHash: hash,
    request_hash: hash,
    requestKey: meta.requestKey || jobRow.request_key || "",
    fetch_status: fetchStatusOf(jobRow),
    attempted_at: jobRow.attempted_at ?? jobRow.attemptedAt ?? null,
    export_id: jobRow.export_id ?? jobRow.exportId ?? null,
    connection_id: jobRow.connection_id ?? jobRow.connectionId ?? meta.connectionId,
  };
}

/**
 * Run ONE source job through the resumable lifecycle. Returns an outcome for signal
 * derivation. Never throws for an expected source failure — it records a safe failure and
 * returns a non-success outcome so the cycle continues.
 */
async function runJobLifecycle({ store, dataDoe, clock, cycleId, job, progress, runWithDeadline }) {
  const requestHash = job.requestHash;
  const requestKey = job.requestKey || "";
  const started = clock();
  const status = job.fetch_status;
  let exportId = job.export_id || null;

  const fail = async (stage, code, message, terminal, rowCount) => {
    await store.recordSourceFailure({ cycleId, requestHash, exportId, stage, code, message, terminal, durationMs: clock() - started, rowCount });
    progress.failed += 1;
    return { requestKey, requestHash, status: terminal ? "terminal" : "failed", validated: false, code };
  };

  // An EXECUTION-deadline deferral (our withDataDoeDeadline, NOT a DataDoe processing
  // timeout) after an export id is saved is RESUMABLE: leave the job 'attempted' with its
  // export_id and record nothing, so the next bounded invocation resumes poll/download
  // without a second create-export. Returns a deferral outcome only when export_id exists;
  // otherwise the caller falls through to a normal failure.
  const deferIfDeadline = (error, stage) => {
    if (isDataDoeDeadlineError(error) && exportId) {
      progress.deferred += 1;
      return { requestKey, requestHash, status: "deferred", validated: false, resumable: true, stage };
    }
    return null;
  };

  // ---- STEPS 1-3: create-export (only for a pending job that wins the atomic claim) ----
  if (status === "pending") {
    const won = await store.claimExportAttempt(cycleId, requestHash);
    if (!won) { progress.skipped += 1; return { requestKey, requestHash, status: "skipped", validated: false, reason: "already-attempted" }; }
    progress.attemptsWon += 1;
    try {
      const created = await runWithDeadline(() => dataDoe.create(job)); // exactly one POST
      exportId = created && created.exportId ? created.exportId : null;
    } catch (error) {
      const cls = classifyFetchError(error, "create-export");
      return fail(cls.stage, cls.code, cls.message, cls.terminal);
    }
    if (!exportId) {
      // The POST returned no export id: an explicit safe failure, never silently skipped.
      return fail("create-export", "CREATE_NO_EXPORT_ID", "DataDoe create-export returned no export id.", false);
    }
    // STEP 3: persist export_id IMMEDIATELY, before any poll/download, so a crash resumes.
    await store.recordExportCreated({ cycleId, requestHash, exportId });
  } else if (status === "attempted") {
    // RESUME: create-export already ran. It must NOT run again.
    if (!exportId) {
      // Claimed but interrupted before an export id was saved: explicit safe failure.
      return fail("create-export", "CREATE_INTERRUPTED", "Create-export was interrupted before an export id was saved.", false);
    }
    // else fall through to poll/download using the saved export_id
  } else {
    return null; // succeeded / failed / skipped: nothing to do
  }

  // ---- STEP 4: poll ----
  try {
    await runWithDeadline(() => dataDoe.poll(job, exportId));
  } catch (error) {
    const deferral = deferIfDeadline(error, "poll");
    if (deferral) return deferral; // resumable: job stays attempted + export_id
    const cls = classifyFetchError(error, "poll");
    return fail(cls.stage, cls.code, cls.message, cls.terminal);
  }

  // ---- STEP 5: download ----
  let rows;
  try {
    rows = await runWithDeadline(() => dataDoe.download(job, exportId));
  } catch (error) {
    const deferral = deferIfDeadline(error, "download");
    if (deferral) return deferral; // resumable: job stays attempted + export_id
    const cls = classifyFetchError(error, "download");
    return fail(cls.stage, cls.code, cls.message, cls.terminal);
  }

  // ---- STEP 6: validate. A non-array payload is a failure (never coerced to []); a
  // strict job at/above its row cap is a truncation failure. Neither is saved. ----
  if (!Array.isArray(rows)) {
    return fail("validate", "MALFORMED_PAYLOAD", "DataDoe payload was not an array; result not saved.", true);
  }
  if (job.strict === true && rows.length >= Number(job.limit)) {
    return fail("validate", "TRUNCATED", "Result reached the row cap; partial data was not saved.", true, rows.length);
  }

  // ---- STEP 7: persist (atomic last-known-good). A save error / empty object path is a
  // SEPARATE persist-stage failure and never overwrites the previous good data. ----
  const payloadBytes = approxPayloadBytes(rows);
  let saveResult;
  try {
    saveResult = await store.saveSourceRows({ job, rows, payloadBytes, exportId, version: `${cycleId}-${exportId}` });
  } catch (error) {
    // A concurrent cycle that ALREADY holds this request's cache pointer is a benign,
    // non-terminal persist conflict, not data loss: we record NO success rather than pair
    // our rows/count with the other cycle's object path. Any other save error is a terminal
    // persist failure. Both preserve the previous last-known-good.
    if (error && error.code === "CACHE_CONFLICT") {
      return fail("persist", "CACHE_CONFLICT", "A concurrent cycle already published this source's cache; this attempt was not recorded as the winner.", false, rows.length);
    }
    return fail("persist", "SAVE_FAILED", "Saving the source result failed; previous data preserved.", true, rows.length);
  }
  // A store returns EITHER a plain object-path string (its own confirmed object) OR a
  // structured { objectPath, rows, rowCount, payloadBytes } when a concurrent winner was
  // ADOPTED. In the adopted case we MUST record the WINNER's rows/count/bytes under the
  // WINNER's path — never this attempt's rows under another object's path.
  const objectPath = typeof saveResult === "string" ? saveResult : (saveResult && saveResult.objectPath) || null;
  const savedRows = saveResult && Array.isArray(saveResult.rows) ? saveResult.rows : rows;
  const savedRowCount = saveResult && typeof saveResult.rowCount === "number" ? saveResult.rowCount : rows.length;
  const savedBytes = saveResult && typeof saveResult.payloadBytes === "number" ? saveResult.payloadBytes : payloadBytes;
  if (!objectPath) {
    return fail("persist", "SAVE_NO_PATH", "Source save returned no object path; treated as a failure.", true, rows.length);
  }

  // ---- STEP 8: record success ----
  await store.recordSourceSuccess({ cycleId, requestHash, exportId, rowCount: savedRowCount, payloadBytes: savedBytes, durationMs: clock() - started, cacheObjectPath: objectPath });
  progress.succeeded += 1;
  return { requestKey, requestHash, status: "success", validated: true, rowCount: savedRowCount, rows: savedRows };
}

/**
 * Run (or resume) the source half of ONE cycle for a fixed set of planned source jobs.
 * Idempotent: upserts each planned job (unique cycle_id+request_hash), then processes the
 * still-pending AND resumable-attempted ones, bounded by maxJobs and a wall-clock
 * deadline. Cumulative cycle counts are recomputed from ALL persisted jobs (never reset).
 * Returns progress + per-job outcomes (rows in-memory for signal derivation) and NEVER a
 * secret. A finished cycle is a no-op.
 */
export async function runSourceJobs({
  store, dataDoe, plannedJobs,
  bucket, cycleDate, scheduledAt = null, trigger = "manual",
  clock = () => Date.now(), deadlineMs = Infinity, reserveMs = DEFAULT_RESERVE_MS, maxJobs = Infinity,
}) {
  if (bucket !== "us" && bucket !== "non-us") throw new Error("bucket must be 'us' or 'non-us'.");
  const progress = {
    cycleId: null, claimedCycle: false, alreadyFinished: false,
    planned: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0, attemptsWon: 0, deferred: 0,
    deadlineReached: false, drained: false,
  };
  const outcomes = [];
  const runWithDeadline = (fn) => withDataDoeDeadline(deadlineMs === Infinity ? Infinity : deadlineMs - reserveMs, fn);

  const cycleId = await store.openCycle({ bucket, cycleDate, scheduledAt, trigger });
  progress.cycleId = cycleId;
  progress.claimedCycle = await store.claimCycle(cycleId);

  const cycle = await store.getCycle(cycleId);
  if (cycle && ["succeeded", "partial", "failed"].includes(cycle.status) && !progress.claimedCycle) {
    progress.alreadyFinished = true;
    progress.drained = true;
    return { ...progress, outcomes };
  }

  for (const job of plannedJobs || []) {
    if (!job || !job.requestHash) continue;
    await store.upsertSourceJob({
      cycleId, bucket,
      requestHash: job.requestHash, requestKey: job.requestKey || "",
      sourceId: job.sourceId || "", sourceKey: job.sourceKey || "",
      connectionId: job.connectionId, // explicit; no 'primary' default in Scheduler v2
      organizationFingerprint: job.organizationFingerprint || "",
      accountScopeHash: job.accountScopeHash || "", requestMeta: job.requestMeta || {},
    });
  }
  const metaByHash = new Map((plannedJobs || []).filter((j) => j && j.requestHash).map((j) => [j.requestHash, j]));
  progress.planned = metaByHash.size;

  const jobRows = await store.listSourceJobs(cycleId);
  for (const jobRow of jobRows) {
    const st = fetchStatusOf(jobRow);
    if (st === "succeeded" || st === "failed" || st === "skipped") continue; // done
    if (progress.processed >= maxJobs) { progress.deadlineReached = false; break; }
    if (clock() >= deadlineMs - reserveMs) { progress.deadlineReached = true; break; }

    const hash = jobRow.request_hash ?? jobRow.requestHash;
    const meta = metaByHash.get(hash);
    progress.processed += 1;
    if (!meta) {
      // A pending/attempted job with no canonical plan entry: fail closed, never silent.
      await store.recordSourceFailure({ cycleId, requestHash: hash, exportId: jobRow.export_id ?? null, stage: st === "attempted" ? "poll" : "create-export", code: "MISSING_PLAN", message: "No canonical plan entry for this source job.", terminal: false, durationMs: 0 });
      progress.failed += 1;
      outcomes.push({ requestKey: "", requestHash: hash, status: "failed", validated: false, code: "MISSING_PLAN" });
      continue;
    }
    const job = mergeJob(meta, jobRow);
    const outcome = await runJobLifecycle({ store, dataDoe, clock, cycleId, job, progress, runWithDeadline });
    if (outcome) outcomes.push(outcome);
  }

  // Cumulative counts + drained state: recomputed from ALL persisted jobs so resuming or
  // adding staged jobs never reduces a previous count.
  const allJobs = await store.listSourceJobs(cycleId);
  const counts = {
    sourceTotal: allJobs.length,
    sourceSucceeded: allJobs.filter((j) => fetchStatusOf(j) === "succeeded").length,
    sourceFailed: allJobs.filter((j) => fetchStatusOf(j) === "failed").length,
  };
  if (store.updateCycleCounts) await store.updateCycleCounts(cycleId, counts);
  const unfinished = allJobs.some((j) => ["pending", "attempted"].includes(fetchStatusOf(j)));
  progress.drained = !unfinished && !progress.deadlineReached;
  progress.counts = counts;
  return { ...progress, outcomes };
}
