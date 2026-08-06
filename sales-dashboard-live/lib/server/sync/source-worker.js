// Scheduler v2 Phase 1c — checkpointable, idempotent source-job worker (SHADOW MODE).
//
// This does NOT replace Scheduler v1 (run-sync.js) and is not wired to any route or
// cron in this commit. It executes the source half of one sync cycle: for each unique
// canonical DataDoe request (identified by request_hash), it makes AT MOST ONE
// create-export call — enforced by the durable claim_source_export_attempt DB guard —
// fetches, validates, and persists the rows, and records fetch / validation / save
// outcomes separately. Repeated invocations resume saved progress without repeating any
// export; failed / timed-out / disabled / truncated / save-failed jobs are not retried
// in the same cycle and never overwrite last-known-good source data.
//
// All I/O is injected so the worker is deterministic and fully testable offline:
//
//   store: {
//     openCycle({bucket,cycleDate,scheduledAt,trigger}) -> cycleId          (idempotent)
//     claimCycle(cycleId) -> boolean            (pending -> running; first worker only)
//     getCycle(cycleId) -> { status, ... } | null
//     upsertSourceJob({cycleId,bucket,...job}) -> void   (idempotent on cycle+hash)
//     listSourceJobs(cycleId) -> [ { request_hash, request_key, fetch_status, ... } ]
//     claimExportAttempt(cycleId, requestHash) -> boolean  (the one-attempt RPC)
//     saveSourceRows({job,rows,payloadBytes,exportId}) -> cacheObjectPath
//     recordSourceSuccess({...}) -> void
//     recordSourceFailure({...}) -> void
//     updateCycleCounts?(cycleId, counts) -> void
//   }
//   fetchSource(job) -> { rows, payloadBytes?, exportId? }   (throws typed DataDoe errors)
//
// The store methods correspond 1:1 to the SQL in 20260807_scheduler_v2.sql; the
// production adapter (source-sync-driver.js) wires them to lib/server/supabase.js.

import { isDataDoeDeadlineError, isSourceDisabledError } from "../datadoe.js";

const DEFAULT_RESERVE_MS = 3_000; // stop before the server cap so status/locks persist

// Approximate serialized payload size WITHOUT retaining a big string; used only for
// telemetry (payload_bytes), never for validation.
function approxPayloadBytes(rows) {
  try { return Buffer.byteLength(JSON.stringify(rows ?? [])); } catch { return 0; }
}

// Map any fetch error to a SAFE {stage, code, message, terminal}. The stored message is
// a fixed operator string — never the raw DataDoe error, a URL, an id, or a key — so no
// secret can leak into status/error output. 4xx client errors are terminal (a retry
// will not fix them); 5xx / timeouts are transient (a future cycle may succeed).
export function classifyFetchError(error) {
  if (isDataDoeDeadlineError(error)) {
    return { stage: "poll", code: "TIMEOUT", message: "DataDoe work deferred at the execution deadline.", terminal: false };
  }
  if (isSourceDisabledError(error)) {
    return { stage: "create-export", code: "SOURCE_DISABLED", message: "Source is disabled for this organization.", terminal: true };
  }
  const raw = error instanceof Error ? error.message : String(error);
  const matched = raw.match(/\((\d{3})\)/); // e.g. "DataDoe export creation failed (403): ..."
  if (matched) {
    const status = Number(matched[1]);
    if (status >= 400 && status <= 599) {
      const terminal = status >= 400 && status < 500; // client errors are permanent for this source
      return { stage: "create-export", code: `HTTP_${status}`, message: `DataDoe returned HTTP ${status} for this source.`, terminal };
    }
  }
  if (/timed out/i.test(raw)) {
    return { stage: "poll", code: "TIMEOUT", message: "DataDoe export timed out while processing.", terminal: false };
  }
  return { stage: "create-export", code: "EXPORT_ERROR", message: "DataDoe export failed for this source.", terminal: false };
}

function fetchStatusOf(job) {
  return job.fetch_status ?? job.fetchStatus ?? "pending";
}

/**
 * Process ONE source job through the full lifecycle. Returns an outcome object the
 * caller uses for signal derivation. Never throws for an expected source failure — it
 * records the failure and returns a non-success outcome so the cycle continues.
 */
async function processOneJob({ store, fetchSource, clock, cycleId, job, progress }) {
  const requestHash = job.request_hash ?? job.requestHash;
  const requestKey = job.request_key ?? job.requestKey ?? "";
  const started = clock();

  // Durable one-attempt guard. Only the caller that flips attempted_at NULL -> now()
  // may create an export; every concurrent/repeat caller gets false and MUST NOT
  // create one. This holds across separate serverless invocations.
  const won = await store.claimExportAttempt(cycleId, requestHash);
  if (!won) {
    progress.skipped += 1;
    return { requestKey, requestHash, status: "skipped", validated: false, reason: "already-attempted" };
  }
  progress.attemptsWon += 1;

  let rows; let payloadBytes; let exportId;
  try {
    const result = await fetchSource(job);
    rows = Array.isArray(result?.rows) ? result.rows : [];
    payloadBytes = Number.isFinite(result?.payloadBytes) ? result.payloadBytes : approxPayloadBytes(rows);
    exportId = result?.exportId ?? null;
  } catch (error) {
    const cls = classifyFetchError(error);
    await store.recordSourceFailure({
      cycleId, requestHash, exportId: error?.exportId ?? null,
      stage: cls.stage, code: cls.code, message: cls.message, terminal: cls.terminal,
      durationMs: clock() - started,
    });
    progress.failed += 1;
    return { requestKey, requestHash, status: cls.terminal ? "terminal" : "failed", validated: false, code: cls.code };
  }

  // VALIDATE stage. A result sitting on the row cap is indistinguishable from a
  // truncated one, so a strict job at/above its limit is a validation failure — never
  // saved. (An honestly empty success, e.g. zero SQP rows, is a valid success.)
  if (job.strict === true && rows.length >= Number(job.limit)) {
    await store.recordSourceFailure({
      cycleId, requestHash, exportId,
      stage: "validate", code: "TRUNCATED",
      message: "Result reached the row cap; partial data was not saved.", terminal: true,
      durationMs: clock() - started, rowCount: rows.length,
    });
    progress.failed += 1;
    return { requestKey, requestHash, status: "terminal", validated: false, code: "TRUNCATED" };
  }

  // PERSIST stage, recorded SEPARATELY: a Supabase save failure is never reported as a
  // DataDoe fetch failure, and it never overwrites last-known-good rows.
  let cacheObjectPath = null;
  try {
    cacheObjectPath = await store.saveSourceRows({ job, rows, payloadBytes, exportId });
  } catch (error) {
    await store.recordSourceFailure({
      cycleId, requestHash, exportId,
      stage: "persist", code: "SAVE_FAILED",
      message: "Saving the source result failed; previous data preserved.", terminal: true,
      durationMs: clock() - started, rowCount: rows.length,
    });
    progress.failed += 1;
    return { requestKey, requestHash, status: "failed", validated: false, code: "SAVE_FAILED" };
  }

  await store.recordSourceSuccess({
    cycleId, requestHash, exportId,
    rowCount: rows.length, payloadBytes, durationMs: clock() - started, cacheObjectPath,
  });
  progress.succeeded += 1;
  // rows are returned in-memory ONLY to derive typed signals; they are not re-persisted.
  return { requestKey, requestHash, status: "success", validated: true, rowCount: rows.length, rows };
}

/**
 * Run (or resume) the source half of ONE cycle for a fixed set of planned source jobs.
 * Idempotent: upserts each planned job (unique cycle_id+request_hash), then processes
 * only the still-pending ones, bounded by maxJobs and a wall-clock deadline. Returns
 * progress + the per-job outcomes (with rows for signal derivation) and NEVER exposes a
 * secret. A cycle that has already finished is a no-op.
 *
 * plannedJobs: [{ requestHash, requestKey, sourceId, sourceKey, connectionId,
 *   organizationFingerprint, accountScopeHash, requestMeta, bucket, strict, limit }]
 */
export async function runSourceJobs({
  store, fetchSource, plannedJobs,
  bucket, cycleDate, scheduledAt = null, trigger = "manual",
  clock = () => Date.now(), deadlineMs = Infinity, reserveMs = DEFAULT_RESERVE_MS, maxJobs = Infinity,
}) {
  if (bucket !== "us" && bucket !== "non-us") throw new Error("bucket must be 'us' or 'non-us'.");
  const progress = {
    cycleId: null, claimedCycle: false, alreadyFinished: false,
    planned: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0, attemptsWon: 0,
    deadlineReached: false, drained: false,
  };
  const outcomes = [];

  const cycleId = await store.openCycle({ bucket, cycleDate, scheduledAt, trigger });
  progress.cycleId = cycleId;
  progress.claimedCycle = await store.claimCycle(cycleId); // first worker stamps started_at

  const cycle = await store.getCycle(cycleId);
  const finished = cycle && ["succeeded", "partial", "failed"].includes(cycle.status);
  if (finished && !progress.claimedCycle) {
    progress.alreadyFinished = true;
    progress.drained = true;
    return { ...progress, outcomes };
  }

  // Plan: upsert every canonical job once. Re-running is a no-op (unique cycle+hash),
  // so a resumed invocation never duplicates a job or its export.
  for (const job of plannedJobs || []) {
    if (!job || !job.requestHash) continue;
    await store.upsertSourceJob({
      cycleId, bucket,
      requestHash: job.requestHash,
      requestKey: job.requestKey || "",
      sourceId: job.sourceId || "",
      sourceKey: job.sourceKey || "",
      connectionId: job.connectionId || "primary",
      organizationFingerprint: job.organizationFingerprint || "",
      accountScopeHash: job.accountScopeHash || "",
      requestMeta: job.requestMeta || {},
    });
  }
  progress.planned = (plannedJobs || []).filter((j) => j && j.requestHash).length;

  // Metadata the worker needs per hash (strict/limit) that is NOT stored on the job row.
  const metaByHash = new Map((plannedJobs || []).map((j) => [j.requestHash, j]));

  const jobRows = await store.listSourceJobs(cycleId);
  for (const jobRow of jobRows) {
    if (progress.processed >= maxJobs) { progress.drained = false; break; }
    if (clock() >= deadlineMs - reserveMs) { progress.deadlineReached = true; progress.drained = false; break; }
    if (fetchStatusOf(jobRow) !== "pending") continue; // resume: skip completed/attempted/failed

    const meta = metaByHash.get(jobRow.request_hash ?? jobRow.requestHash) || {};
    const job = { ...jobRow, strict: meta.strict === true, limit: meta.limit };
    progress.processed += 1;
    outcomes.push(await processOneJob({ store, fetchSource, clock, cycleId, job, progress }));
  }

  progress.drained = !progress.deadlineReached && progress.processed < maxJobs
    ? true
    : progress.drained;
  // Drained is true only if we reached the end of the pending list without a stop.
  const pendingLeft = (await store.listSourceJobs(cycleId)).some((j) => fetchStatusOf(j) === "pending");
  progress.drained = !pendingLeft && !progress.deadlineReached;

  if (store.updateCycleCounts) {
    await store.updateCycleCounts(cycleId, {
      sourceTotal: jobRows.length,
      sourceSucceeded: progress.succeeded,
      sourceFailed: progress.failed,
    });
  }
  return { ...progress, outcomes };
}
