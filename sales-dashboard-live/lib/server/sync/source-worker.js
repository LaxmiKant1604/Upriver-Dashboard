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

import { isDataDoeDeadlineError, isDataDoePollPendingError, isSourceDisabledError, withDataDoeDeadline } from "../datadoe.js";
import { sourceJobOwnerId } from "../source-identity.js";
import { validateBatchSourcePayload } from "./source-account-isolation.js";

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
  // Defensive: the typed poll-window-exhausted signal is normally intercepted as a resumable
  // deferral BEFORE classification (an export_id always exists at the poll stage). If it ever
  // reaches classification anyway it must stay non-terminal so the export can still be resumed.
  if (isDataDoePollPendingError(error)) {
    return { stage, code: "POLL_PENDING", message: "DataDoe export still processing at the end of the bounded poll window; resumable.", terminal: false };
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
async function runJobLifecycle({ store, dataDoe, clock, cycleId, job, progress, runWithDeadline, reuseOnly = false }) {
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

  // A RESUMABLE deferral after an export id is saved: either an EXECUTION-deadline deferral
  // (our withDataDoeDeadline, NOT a DataDoe processing timeout) or the typed poll-window
  // exhaustion (DataDoePollPendingError -- the bounded window saw ONLY temporary states:
  // repeated status-GET 404 / ordinary PENDING). Both leave the job 'attempted' with its
  // export_id and record NOTHING (no source failure), so the next bounded invocation resumes
  // poll/download of the SAME export without a second create-export. Returns a deferral
  // outcome only when export_id exists; otherwise the caller falls through to a normal failure.
  const deferIfResumable = (error, stage) => {
    if ((isDataDoeDeadlineError(error) || isDataDoePollPendingError(error)) && exportId) {
      progress.deferred += 1;
      return { requestKey, requestHash, status: "deferred", validated: false, resumable: true, stage };
    }
    return null;
  };

  // ---- STEPS 1-3: create-export (only for a pending job that wins the atomic claim) ----
  if (status === "pending") {
    // ---- Part C: confirmed-exact-match DURABLE source-cache reuse, BEFORE any create-export ----
    // A reviewed reuse path that spends ZERO DataDoe calls when a durable, TTL-valid cache entry proves
    // the EXACT canonical request (same request_hash) was already fetched + saved for this exact
    // source_id + organization + account scope. store.loadSourceRows is already TTL-gated (expires_at>now)
    // and array-validated. Reuse is CONFIRMED only when every belt-and-suspenders identity + integrity
    // check holds; ANY miss / expired / unreadable / malformed / mismatched / cap-sized / unconfirmed
    // entry records NOTHING and falls through to the normal claim -> create -> poll -> download -> save
    // path (exactly one create POST per hash). Gated on the store exposing a cache reader, so injected
    // test/canary stores without one keep the old path unchanged.
    if (typeof store.loadSourceRows === "function") {
      let entry = null;
      try { entry = await store.loadSourceRows(requestHash); } catch (_e) { entry = null; }
      const cachedRows = entry && Array.isArray(entry.rows) ? entry.rows : null;
      const cachedSourceId = entry ? (entry.source_id ?? entry.sourceId) : undefined;
      const cachedOrgFp = entry ? (entry.organization_fingerprint ?? entry.organizationFingerprint) : undefined;
      const cachedScope = entry ? (entry.account_scope_hash ?? entry.accountScopeHash) : undefined;
      const cachedPath = entry ? (entry.object_path ?? entry.objectPath) : undefined;
      const cachedRowCount = entry ? (entry.row_count ?? entry.rowCount) : undefined;
      const cachedBytes = entry ? (entry.payload_bytes ?? entry.payloadBytes) : undefined;
      const confirmed = !!cachedRows
        && !!cachedSourceId && cachedSourceId === job.sourceId
        && !!cachedOrgFp && cachedOrgFp === job.organizationFingerprint
        && !!cachedScope && cachedScope === job.accountScopeHash
        && typeof cachedPath === "string" && cachedPath.trim() !== ""
        && typeof cachedRowCount === "number" && cachedRowCount === cachedRows.length
        && !(job.strict === true && cachedRows.length >= Number(job.limit));
      if (confirmed) {
        const payloadBytes = typeof cachedBytes === "number" ? cachedBytes : approxPayloadBytes(cachedRows);
        // Finding 2: durable cache evidence exists, so the ATOMIC CAS is MANDATORY -- there is NO non-CAS
        // fallback. A store missing a well-formed adoptSourceCache must FAIL CLOSED (never fabricate success,
        // never create). Production preflight requires the wrapper + RPC, so this only guards a misconfigured
        // or injected store.
        if (typeof store.adoptSourceCache !== "function") {
          return fail("create-export", "ADOPT_CAS_UNAVAILABLE", "Durable cache evidence exists but the atomic adopt CAS is unavailable; refusing to create or fabricate (fail closed).", false);
        }
        // Blocker 2 + senior review: the caller's values are EXPECTATIONS. adopt_source_export_cache
        // re-reads + LOCKS the ACTUAL current cache row, validates full identity + integrity + expiry, and
        // adopts the job with the DB row's OWN values ONLY while still pending/unattempted/count=0. It is
        // mutually exclusive with claim_source_export_attempt (both require fetch_status='pending'), so a
        // concurrent create-claim and this reuse have exactly ONE winner and ZERO fabricated export ids.
        const ack = await store.adoptSourceCache({
          cycleId, requestHash,
          sourceId: job.sourceId, organizationFingerprint: job.organizationFingerprint, accountScopeHash: job.accountScopeHash,
          objectPath: cachedPath, rowCount: cachedRowCount, payloadBytes,
        });
        if (ack === "adopted") {
          progress.succeeded += 1;
          return { requestKey, requestHash, status: "success", validated: true, rowCount: cachedRowCount, rows: cachedRows, reused: true };
        }
        if (ack === "not-adopted") {
          // The cache matched but the job row was concurrently advanced (claimed/succeeded/failed). Do NOT
          // record anything over the winner; a fresh invocation re-reads the true status and resumes/skips.
          progress.skipped += 1;
          return { requestKey, requestHash, status: "skipped", validated: false, reason: "adopt-not-won" };
        }
        if (ack === "cache-changed" || ack === "cache-expired") {
          // The exact cache we validated is no longer current (replaced/pruned/expired between our read and
          // the CAS). It is NOT reusable now: fall through to the normal path (reuseOnly -> MISSING_REUSABLE_
          // SOURCE; else claim -> create). Nothing is recorded here.
        } else {
          // A MALFORMED acknowledgement (not one of the four typed values). Fail closed: never create, never
          // claim success.
          return fail("create-export", "ADOPT_ACK_MALFORMED", "The atomic adopt CAS returned a malformed acknowledgement; refusing to create or fabricate (fail closed).", false);
        }
      }
    }
    // Blocker 3: reuseOnly REHEARSAL gate. No durable exact cache entry was adopted above, and a pending
    // job has no saved export_id to resume, so this source is NOT reusable. A rehearsal pass must create
    // ZERO exports: leave the job pending (blocked, NOT failed), record nothing durable, and return a
    // typed MISSING_REUSABLE_SOURCE outcome as evidence. The create-export POST is never reached.
    if (reuseOnly) {
      progress.missingReusable += 1;
      return { requestKey, requestHash, status: "missing-reusable-source", validated: false, code: "MISSING_REUSABLE_SOURCE" };
    }
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
    const deferral = deferIfResumable(error, "poll");
    if (deferral) return deferral; // resumable: job stays attempted + export_id
    const cls = classifyFetchError(error, "poll");
    return fail(cls.stage, cls.code, cls.message, cls.terminal);
  }

  // ---- STEP 5: download ----
  let rows;
  try {
    rows = await runWithDeadline(() => dataDoe.download(job, exportId));
  } catch (error) {
    const deferral = deferIfResumable(error, "download");
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

  // ---- Blocker 4c: BATCH INTEGRITY. A seller-scoped source fetched over a <=5-account BATCH (more than one
  // canonical seller id) must contain ONLY rows for those exact sellers, so ONE canonical payload can be split
  // back per account at derive time. Reject the WHOLE batch (never saved) on any blank/unknown/cross-account
  // (cross-org) seller id; a zero-row batch stays valid-empty. A single-account source (<=1 id) and a
  // non-seller-scoped source (no seller_or_vendor_id column, e.g. Product Catalog) are unaffected. ----
  const fp = job.fetchParams || {};
  const batchIds = Array.isArray(fp.sellerOrVendorIds) ? fp.sellerOrVendorIds : [];
  if (batchIds.length > 1) {
    const bv = validateBatchSourcePayload({ rows, sellerOrVendorIds: batchIds, columns: fp.columns });
    if (!bv.valid) {
      return fail("validate", bv.code || "BATCH_INVALID", bv.reason || "Batch payload failed per-account integrity validation; result not saved.", true, rows.length);
    }
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
 *
 * Ownership (Scheduler v2 many-to-many model): a shared (bucket, cycle_date) cycle can hold canonical
 * source jobs owned by SEVERAL report families/accounts. `sync_source_jobs` stays ONE row/export per
 * canonical request_hash; WHO may process/resume/read it lives in `sync_source_job_owners` memberships.
 * When `ownerIds` is supplied this invocation:
 *   - validates every plannedJob carries a complete owner membership belonging to a declared owner id
 *     BEFORE any source/owner upsert (fail closed on empty/malformed/mismatched ownership);
 *   - upserts the canonical source jobs ONCE by request_hash, then the owner memberships SEPARATELY;
 *   - loads the union of canonical hashes its declared owners own (durable, active memberships), so two
 *     owners needing the same hash still produce exactly ONE export and either can resume it;
 *   - processes ONLY its owned+planned canonical jobs -- another owner's job is never processed, failed,
 *     counted against maxJobs, or included in owner-scoped `drained`; and
 *   - never MISSING_PLANs a canonical row: a hash an owner no longer plans is reconciled at the OWNER
 *     membership level by the driver (stale), never by failing the shared canonical row.
 * When `ownerIds` is null the invocation owns the whole cycle (legacy single-owner path, unchanged).
 * Cumulative cycle counts are recomputed from ALL canonical jobs (never owner aliases). A finished cycle
 * is a no-op. Returns progress + per-job outcomes (rows in-memory for signal derivation); NEVER a secret.
 */
export async function runSourceJobs({
  store, dataDoe, plannedJobs, ownerIds = null,
  bucket, cycleDate, scheduledAt = null, trigger = "manual",
  clock = () => Date.now(), deadlineMs = Infinity, reserveMs = DEFAULT_RESERVE_MS, maxJobs = Infinity,
  // BUILD-TIME source-tranche selector (Part A). When present, EXECUTE only the jobs it selects; the
  // full plan is still upserted (all canonical jobs + owner memberships). null => execute everything
  // (behavior byte-identical to before). NEVER a per-run/untrusted argument (see runtime-composition).
  sourceTranche = null,
  // BUILD-TIME reuseOnly REHEARSAL flag (Blocker 3). When true a pending job that cannot be satisfied by a
  // durable cache adoption (or a saved export_id resume) creates ZERO exports and returns
  // MISSING_REUSABLE_SOURCE. NEVER a per-run/untrusted argument (see runtime-composition).
  reuseOnly = false,
}) {
  if (bucket !== "us" && bucket !== "non-us") throw new Error("bucket must be 'us' or 'non-us'.");
  const progress = {
    cycleId: null, claimedCycle: false, alreadyFinished: false,
    planned: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0, attemptsWon: 0, deferred: 0,
    missingReusable: 0, deadlineReached: false, drained: false,
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

  const usingOwners = Array.isArray(ownerIds);
  const ownerSet = usingOwners ? new Set(ownerIds.map((id) => String(id || "")).filter(Boolean)) : null;
  const planned = (plannedJobs || []).filter((j) => j && j.requestHash);

  // Fail closed BEFORE any source/owner upsert AND before any DataDoe call (req 10/11 + Blocker 2): every
  // plannedJob must carry COMPLETE owner metadata, its owner.requestKey must equal the canonical
  // job.requestKey, and its supplied owner_id must EQUAL the value RECOMPUTED from the authoritative tuple
  // sourceJobOwnerId(reportKey, connectionId, organization_fingerprint, account_scope_hash). owner_id is
  // never trusted just because it appears in ownerIds -- so a buggy caller can never place an account/org
  // job under another declared owner. The recomputed owner must also be in the declared owner scope.
  if (usingOwners) {
    if (!ownerSet.size && planned.length) {
      throw new Error("runSourceJobs was given planned jobs but an empty ownerIds scope; refusing (fail closed).");
    }
    for (const j of planned) {
      const o = j.owner || {};
      const ownerId = String(o.ownerId || "");
      const rk = j.requestKey || "";
      // Blocker 4b: the OWNER scope is the INDIVIDUAL account (o.accountScopeHash), which for a batched job
      // differs from the canonical job's BATCH scope (j.accountScopeHash). Legacy single-account callers do
      // not set owner.accountScopeHash, so it falls back to the canonical scope (byte-identical behavior).
      const ownerScope = o.accountScopeHash || j.accountScopeHash;
      if (!ownerId || !o.reportKey || !o.accountId || !o.requestKey || !j.connectionId || !j.organizationFingerprint || !j.accountScopeHash || !ownerScope) {
        throw new Error(`plannedJobs entry (request_key "${o.requestKey || rk}") is missing owner membership metadata (owner_id / report_key / account_id / request_key / connection_id / organization_fingerprint / account_scope_hash / owner scope); fail closed.`);
      }
      if (o.requestKey !== rk) {
        throw new Error(`plannedJobs entry owner.request_key "${o.requestKey}" does not match the canonical job request_key "${rk}"; fail closed.`);
      }
      // Recompute owner_id from the INDIVIDUAL owner scope (never the batch scope), so a batched job's five
      // owners resolve to FIVE distinct owner_ids and a buggy caller can never place a cross-account owner.
      const expected = sourceJobOwnerId({ reportKey: o.reportKey, connectionId: j.connectionId, organizationFingerprint: j.organizationFingerprint, accountScopeHash: ownerScope });
      if (!expected || expected !== ownerId) {
        throw new Error(`plannedJobs entry (request_key "${rk}") owner_id does not match sourceJobOwnerId(report_key, connection_id, organization_fingerprint, individual account_scope_hash); refusing (fail closed).`);
      }
      if (!ownerSet.has(ownerId)) {
        throw new Error(`plannedJobs entry (owner_id "${ownerId}") does not belong to the declared owner scope; refusing to upsert then skip it.`);
      }
    }
  }

  // 1) Upsert the CANONICAL source jobs ONCE by request_hash (dedup: two owners sharing a hash => one row).
  const metaByHash = new Map();
  for (const j of planned) if (!metaByHash.has(j.requestHash)) metaByHash.set(j.requestHash, j);
  for (const job of metaByHash.values()) {
    await store.upsertSourceJob({
      cycleId, bucket,
      requestHash: job.requestHash, requestKey: job.requestKey || "",
      sourceId: job.sourceId || "", sourceKey: job.sourceKey || "",
      connectionId: job.connectionId, // explicit; no 'primary' default in Scheduler v2
      organizationFingerprint: job.organizationFingerprint || "",
      accountScopeHash: job.accountScopeHash || "", requestMeta: job.requestMeta || {},
    });
  }

  // 2) Upsert the OWNER memberships SEPARATELY (one per planned owner+source pair). A shared canonical
  //    hash across two of this invocation's owners produces two memberships against the one canonical row.
  if (usingOwners && store.upsertSourceJobOwners) {
    await store.upsertSourceJobOwners(planned.map((j) => ({
      cycleId, requestHash: j.requestHash, ownerId: j.owner.ownerId, requestKey: j.owner.requestKey,
      reportKey: j.owner.reportKey, accountId: j.owner.accountId, connectionId: j.connectionId,
      // The owner membership records the INDIVIDUAL account scope (Blocker 4b), never the canonical batch
      // scope -- "owner scope remains one exact report/account". Falls back to the canonical scope for a
      // legacy single-account job (where the two are identical).
      organizationFingerprint: j.organizationFingerprint, accountScopeHash: j.owner.accountScopeHash || j.accountScopeHash,
    })));
  }

  // 3) The union of canonical hashes the declared owners own (durable, active memberships across this +
  //    prior rounds), plus this round's planned hashes. Only these are executed / drained-scoped.
  let ownedHashes = null;
  if (usingOwners) {
    const durable = store.listSourceJobOwners ? await store.listSourceJobOwners(cycleId, [...ownerSet]) : [];
    ownedHashes = new Set([
      ...metaByHash.keys(),
      ...durable.filter((m) => (m.owner_status ?? m.ownerStatus) !== "stale").map((m) => m.request_hash ?? m.requestHash),
    ]);
  }
  const ownsHash = (hash) => !usingOwners || ownedHashes.has(hash);
  progress.planned = metaByHash.size;

  // 4) Execute. New model: process ONLY this invocation's owned+planned canonical jobs (deduped by hash);
  //    a canonical row owned but not planned this round is left untouched (readable LKG). Legacy model
  //    (no ownerIds): scan every row and fail an unplanned one MISSING_PLAN, as before.
  const jobRows = await store.listSourceJobs(cycleId);
  const rowByHash = new Map(jobRows.map((r) => [r.request_hash ?? r.requestHash, r]));
  const executeHashesAll = usingOwners
    ? [...metaByHash.keys()].filter(ownsHash)
    : [...rowByHash.keys()];
  // Build-time tranche NARROWING (Part A): execute only the selected source families this pass. The
  // upsert loops above already ran over the FULL planned set, so every canonical job + owner membership
  // is durably created; unselected families stay pending/retryable, `drained` stays false (below), and
  // the NEXT tranche resumes this exact (bucket, cycle_date) cycle. selects() reads source_key (or the
  // request_hash allowlist) off the canonical job. A null tranche keeps executeHashes identical.
  const executeHashes = (sourceTranche && typeof sourceTranche.selects === "function")
    ? executeHashesAll.filter((hash) => {
      const meta = metaByHash.get(hash);
      const jobRow = rowByHash.get(hash);
      const sourceKey = (meta && meta.sourceKey) || (jobRow && (jobRow.source_key ?? jobRow.sourceKey)) || "";
      return sourceTranche.selects({ sourceKey, requestHash: hash });
    })
    : executeHashesAll;
  for (const hash of executeHashes) {
    const jobRow = rowByHash.get(hash);
    if (!jobRow) continue;
    const st = fetchStatusOf(jobRow);
    if (st === "succeeded" || st === "failed" || st === "skipped") continue; // done (a shared hash B already fetched is read, not re-run)
    if (progress.processed >= maxJobs) { progress.deadlineReached = false; break; }
    if (clock() >= deadlineMs - reserveMs) { progress.deadlineReached = true; break; }

    const meta = metaByHash.get(hash);
    progress.processed += 1;
    if (!meta) {
      // Legacy path only: an unplanned pending/attempted row is a genuine orphan -> fail closed. In the
      // owner model this never happens (executeHashes are all planned) and stale is an owner-level concern.
      await store.recordSourceFailure({ cycleId, requestHash: hash, exportId: jobRow.export_id ?? null, stage: st === "attempted" ? "poll" : "create-export", code: "MISSING_PLAN", message: "No canonical plan entry for this source job.", terminal: false, durationMs: 0 });
      progress.failed += 1;
      outcomes.push({ requestKey: "", requestHash: hash, status: "failed", validated: false, code: "MISSING_PLAN" });
      continue;
    }
    const job = mergeJob(meta, jobRow);
    const outcome = await runJobLifecycle({ store, dataDoe, clock, cycleId, job, progress, runWithDeadline, reuseOnly });
    if (outcome) outcomes.push(outcome);
  }

  // Cumulative counts recomputed from ALL CANONICAL jobs (cycle-wide telemetry, never owner aliases).
  // `drained` is scoped to the declared owners' hashes so one owner's completion never depends on
  // another owner's still-pending jobs in the shared cycle.
  const allJobs = await store.listSourceJobs(cycleId);
  const counts = {
    sourceTotal: allJobs.length,
    sourceSucceeded: allJobs.filter((j) => fetchStatusOf(j) === "succeeded").length,
    sourceFailed: allJobs.filter((j) => fetchStatusOf(j) === "failed").length,
  };
  if (store.updateCycleCounts) await store.updateCycleCounts(cycleId, counts);
  const unfinished = allJobs.some((j) => ownsHash(j.request_hash ?? j.requestHash) && ["pending", "attempted"].includes(fetchStatusOf(j)));
  progress.drained = !unfinished && !progress.deadlineReached;
  progress.counts = counts;
  return { ...progress, outcomes };
}
