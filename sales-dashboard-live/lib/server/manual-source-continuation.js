// Durable server-side continuation for MANUAL DataDoe source exports (the /api/datadoe path).
//
// Scheduler v2 persists export_id in sync_source_jobs and resumes it. The manual/legacy
// fetchSourceChunk path only held its in-flight export in process memory, so when a
// DataDoePollPendingError / DataDoeDeadlineError escaped and the route answered 504
// retryable:true, the NEXT HTTP request (a fresh serverless invocation) called createExport
// again and could spend another DataDoe token. This module makes the manual path resumable:
// a small durable ATTEMPT MARKER keyed by the exact canonical request_hash, stored with the
// project's approved report_snapshots INSERT-IF-ABSENT + rev-CAS action-manifest pattern
// (same primitives as the brand-catalog action manifest; NO new migration, NO new table).
//
// Marker identity (cannot collide with user reports, brand-catalog rows, or scheduler-v2/*
// shadow snapshots -- all three key fields are dedicated):
//   report_key  = "manual-source-attempt"
//   account_id  = "__manual-source-attempt__"
//   params_hash = paramsHashFor("manual-source-attempt-v1", { requestHash })
//
// Marker payload is SAFE TYPED STATE ONLY: { version, requestHash, organizationFingerprint,
// sourceId, status, exportId, code, rev, createdAt, updatedAt, expiresAt }. NEVER an API key,
// raw DataDoe error, downloaded rows, or response body. `code` is a fixed admin-safe token.
//
// State model ("creating" -> "polling" -> removed; "failed" is re-claimable):
//   1. No marker: atomic INSERT-IF-ABSENT of status="creating" BEFORE the create POST; only
//      the insert winner may call createExport. If the claim cannot be written: fail closed
//      (typed CONTINUATION_UNAVAILABLE) -- no POST.
//   2. A concurrent/replayed request that sees a FRESH "creating" marker makes ZERO POSTs and
//      returns the typed IN_PROGRESS signal (retryable; the owner's durable marker exists).
//      It never overwrites the owner's marker.
//   3. Create success: the exportId is persisted with a rev-CAS transition to "polling"
//      BEFORE any poll.
//   4. Poll-window exhaustion / execution deadline (after exportId persisted): the marker and
//      exportId are preserved; the typed error escapes flagged durableContinuation=true so the
//      route may answer retryable:true.
//   5. A separate later HTTP request recomputes the same request_hash, loads the marker, and
//      resumes poll/download of the SAVED export id -- zero new create POSTs.
//   6. Completion: rows are persisted through the normal source cache FIRST (the injected
//      finishRows). The marker is removed ONLY when that durable persistence is POSITIVELY
//      CONFIRMED (finishRows -> { persisted:true }). In-memory caching alone is insufficient, so a
//      skipped/failed persist, a low deadline, an oversized payload, or cap-sized rows all leave
//      the "polling" marker (with its exportId) in place -- a later invocation then resumes and
//      re-downloads the SAME export with zero new create-export POSTs. A stale "polling" marker
//      left after a confirmed durable save is harmless (the source cache is consulted first).
//   7. DEFINITE create failure (DataDoe answered the POST with an error status): the marker
//      records only the admin-safe typed code and becomes "failed" -- re-claimable via CAS,
//      because no export was created.
//   8. AMBIGUOUS create outcome (deadline/abort/transport error while the POST may have been
//      dispatched) or a marker-transition failure (CAS throw/loss): fail closed. The marker is
//      left in "creating" and NOTHING auto-creates another export for it.
//   9. Retention (conservative, documented): a "creating" marker older than CREATING_TTL_MS
//      (10 minutes -- far beyond any real create round-trip) means its owner died with the
//      create outcome UNKNOWN. It is surfaced as the typed UNCERTAIN signal (never retryable,
//      never auto-created); clearing it is a deliberate admin action
//      (deleteReportSnapshotByKey) after review. "polling" markers never block anything --
//      resuming a saved export id is free -- and are removed on completion; "failed" markers
//      are re-claimed on demand. No background pruner and no schedule is added.
//  10. Existing valid source-cache hits return in fetchSourceChunk BEFORE this module runs --
//      no marker and no export is ever created for cached data.
//
// All storage I/O is injectable (deps.store / test overrides), mirroring the brand-catalog
// orchestrator, so the protocol is fully offline-testable.

import {
  casUpdateReportSnapshotByRev,
  deleteReportSnapshotByKey,
  getReportSnapshot,
  insertReportSnapshotIfAbsent,
  isSafeSnapshotRev,
  isSupabaseConfigured,
} from "./supabase.js";
import { paramsHashFor } from "./report-store.js";

export const MANUAL_SOURCE_ATTEMPT_KEY = "manual-source-attempt";
export const MANUAL_SOURCE_ATTEMPT_ACCOUNT = "__manual-source-attempt__";
const MANUAL_SOURCE_ATTEMPT_VERSION = "manual-source-attempt-v1";

// A create POST + response completes in seconds; 10 minutes is far beyond any stalled
// serverless invocation. After it, the owner is certainly dead and the create outcome is
// UNCERTAIN -- the marker then blocks auto-creation (state 9) until deliberately cleared.
const CREATING_TTL_MS = 10 * 60_000;
// "polling" markers never block (resume is free); expiresAt is informational bookkeeping.
const POLLING_TTL_MS = 24 * 3600_000;

// Admin-safe typed codes -- never raw DataDoe/Supabase text.
export const MANUAL_CONTINUATION_IN_PROGRESS = "MANUAL_SOURCE_IN_PROGRESS";
export const MANUAL_CONTINUATION_UNAVAILABLE = "MANUAL_SOURCE_CONTINUATION_UNAVAILABLE";
export const MANUAL_CONTINUATION_UNCERTAIN = "MANUAL_SOURCE_ATTEMPT_UNCERTAIN";

export class ManualSourceContinuationError extends Error {
  constructor(code, retryable, message) {
    super(message);
    this.name = "ManualSourceContinuationError";
    this.code = code;
    this.retryable = retryable === true;
    // retryable implies a durable marker exists (the owner's); the route checks this flag.
    this.durableContinuation = retryable === true;
  }
}

export function isManualSourceContinuationError(error) {
  return error instanceof ManualSourceContinuationError
    || (error != null && typeof error.code === "string" && error.code.startsWith("MANUAL_SOURCE_"));
}

const inProgressErr = () => new ManualSourceContinuationError(
  MANUAL_CONTINUATION_IN_PROGRESS, true,
  "Another request is already fetching this data. Retry shortly to reuse its result.",
);
const unavailableErr = () => new ManualSourceContinuationError(
  MANUAL_CONTINUATION_UNAVAILABLE, false,
  "A durable continuation record could not be established; the export was not created.",
);
const uncertainErr = () => new ManualSourceContinuationError(
  MANUAL_CONTINUATION_UNCERTAIN, false,
  "A previous attempt for this data ended in an uncertain state and needs review before retrying.",
);

const attemptParamsHash = (requestHash) => paramsHashFor(MANUAL_SOURCE_ATTEMPT_VERSION, { requestHash });
const norm = (value) => String(value ?? "").trim();

// The only marker states the protocol writes. Any other value is malformed => fail closed.
const KNOWN_MARKER_STATUSES = new Set(["creating", "polling", "failed"]);
// A "failed" marker carries exactly one of these admin-safe typed codes.
const FAILED_MARKER_CODE_RE = /^(CREATE_FAILED(_\d{3})?|EXPORT_FAILED)$/;

/**
 * Validate a LOADED marker against the CURRENT request identity BEFORE any DataDoe call or any
 * marker mutation (Blocker 2). Returns true only when EVERY field is present, well-formed, and
 * matches: the marker version, the exact request_hash, the organization fingerprint, the source
 * id, a known status, a status/exportId/code combination the protocol actually writes, a safe
 * rev, and parseable timestamps. Any missing/mismatched/malformed field returns false, and the
 * caller then fails closed (zero DataDoe calls, zero marker mutation). Pure; never throws.
 */
function markerIdentityMatches(marker, { requestHash, organizationFingerprint, sourceId }) {
  if (!marker || typeof marker !== "object") return false;
  if (marker.version !== MANUAL_SOURCE_ATTEMPT_VERSION) return false;
  if (!isSafeSnapshotRev(marker.rev)) return false;
  if (norm(marker.requestHash) !== norm(requestHash)) return false;
  if (norm(marker.organizationFingerprint) !== norm(organizationFingerprint)) return false;
  if (norm(marker.sourceId) !== norm(sourceId)) return false;
  if (!KNOWN_MARKER_STATUSES.has(marker.status)) return false;
  const exportId = norm(marker.exportId);
  const code = marker.code == null ? null : String(marker.code);
  if (marker.status === "polling") {
    if (!exportId) return false;      // a polling marker MUST carry the export id to resume
    if (code !== null) return false;  // ...and carries no failure code
  } else if (marker.status === "creating") {
    if (exportId) return false;       // the claim precedes the export id
    if (code !== null) return false;
  } else if (marker.status === "failed") {
    if (exportId) return false;       // a failed attempt has no resumable export id
    if (code === null || !FAILED_MARKER_CODE_RE.test(code)) return false; // typed code required
  }
  for (const field of ["createdAt", "updatedAt", "expiresAt"]) {
    if (!Number.isFinite(Date.parse(marker[field]))) return false;
  }
  return true;
}

// ---- default durable store on report_snapshots (insert-if-absent + rev-CAS + delete) ----
// save() contract (identical to the brand-catalog manifest saver): marker.rev == null =>
// CREATE via atomic INSERT-IF-ABSENT at rev 1, returning 1 when inserted or false on
// conflict; marker.rev set => CAS UPDATE to rev+1, returning the new rev or false when the
// CAS lost. THROWS on transport failure.
const defaultStore = {
  async load(requestHash) {
    const snapshot = await getReportSnapshot({
      reportKey: MANUAL_SOURCE_ATTEMPT_KEY,
      accountId: MANUAL_SOURCE_ATTEMPT_ACCOUNT,
      paramsHash: attemptParamsHash(requestHash),
    });
    return snapshot?.payload || null;
  },
  async save(requestHash, marker) {
    const paramsHash = attemptParamsHash(requestHash);
    const sourceRefreshedAt = marker.updatedAt || new Date().toISOString();
    if (marker.rev == null) {
      const payload = { ...marker, rev: 1 };
      const inserted = await insertReportSnapshotIfAbsent({
        reportKey: MANUAL_SOURCE_ATTEMPT_KEY,
        accountId: MANUAL_SOURCE_ATTEMPT_ACCOUNT,
        paramsHash,
        params: { reportVersion: MANUAL_SOURCE_ATTEMPT_VERSION, requestHash: marker.requestHash },
        payload,
        payloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
        sourceRefreshedAt,
      });
      return inserted ? 1 : false;
    }
    if (!isSafeSnapshotRev(marker.rev)) {
      throw new Error("manual-source-continuation: existing marker rev is not a positive safe integer.");
    }
    const expectedRev = marker.rev;
    const payload = { ...marker, rev: expectedRev + 1 };
    const won = await casUpdateReportSnapshotByRev({
      reportKey: MANUAL_SOURCE_ATTEMPT_KEY,
      accountId: MANUAL_SOURCE_ATTEMPT_ACCOUNT,
      paramsHash,
      expectedRev,
      payload,
      sourceRefreshedAt,
    });
    return won ? expectedRev + 1 : false;
  },
  async remove(requestHash) {
    await deleteReportSnapshotByKey({
      reportKey: MANUAL_SOURCE_ATTEMPT_KEY,
      accountId: MANUAL_SOURCE_ATTEMPT_ACCOUNT,
      paramsHash: attemptParamsHash(requestHash),
    });
    return true;
  },
};

// Test seam (offline suites only): inject { enabled, store } so the protocol runs against an
// in-memory store without Supabase. Production never calls this.
let testOverrides = null;
export function __setManualSourceContinuationTestOverrides(overrides) {
  testOverrides = overrides || null;
}

// The durable protocol runs only where the durable store exists. Without it (local dev /
// offline tests) the caller falls back to the legacy single-invocation flow and MUST mark any
// resumable escape non-durable so the route never advertises retryable:true (finding 1).
export function manualSourceContinuationEnabled() {
  if (testOverrides) return testOverrides.enabled === true;
  return isSupabaseConfigured();
}

/**
 * Run one manual source export attempt under the durable continuation protocol.
 *
 * input: {
 *   requestHash, organizationFingerprint, sourceId,       // safe identity fields (marker body)
 *   create()  -> DataDoe create response,                  // exactly-once via the marker claim
 *   poll(exportId), download(exportId) -> rows,
 *   finishRows(rows) -> { rows, persisted },               // persists via the NORMAL source cache;
 *                                                          // `persisted` true ONLY on a confirmed
 *                                                          // durable save (gates marker removal)
 *   isResumableEscape(error) -> boolean,                   // poll-pending OR execution deadline
 *   isDefiniteCreateFailure(error) -> boolean,             // DataDoe ANSWERED the POST with an error
 *   deps?: { store }                                       // test injection (else overrides/default)
 * }
 */
export async function runManualSourceAttempt(input) {
  const {
    requestHash, organizationFingerprint, sourceId,
    create, poll, download, finishRows, isResumableEscape, isDefiniteCreateFailure,
  } = input;
  const store = (input.deps && input.deps.store) || (testOverrides && testOverrides.store) || defaultStore;

  const iso = (ms) => new Date(ms).toISOString();
  const markerBody = (status, exportId, code, prev) => ({
    version: MANUAL_SOURCE_ATTEMPT_VERSION,
    requestHash,
    organizationFingerprint: norm(organizationFingerprint),
    sourceId: norm(sourceId),
    status,
    exportId: exportId || null,
    code: code || null,
    createdAt: prev ? prev.createdAt : iso(Date.now()),
    updatedAt: iso(Date.now()),
    expiresAt: iso(Date.now() + (status === "creating" ? CREATING_TTL_MS : POLLING_TTL_MS)),
  });
  const trySave = async (marker) => { try { return await store.save(requestHash, marker); } catch { return null; } };
  const markDurable = (error) => { error.durableContinuation = true; return error; };

  // Resume poll/download of a persisted export id. NEVER creates.
  async function resumePollDownload(marker, { skipPoll = false } = {}) {
    const exportId = norm(marker.exportId);
    if (!skipPoll) {
      try {
        await poll(exportId);
      } catch (error) {
        // Window exhaustion / deadline: exportId stays persisted; escape as durable-resumable.
        if (isResumableEscape(error)) throw markDurable(error);
        // Genuine export failure (FAILED / status 500 / ...): record the admin-safe typed state.
        // The export is dead, so the marker becomes "failed" (re-claimable: re-creating later is
        // legitimate and matches the pre-continuation manual behavior).
        await trySave({ ...markerBody("failed", null, "EXPORT_FAILED", marker), rev: marker.rev });
        throw error;
      }
    }
    let rows;
    try {
      rows = await download(exportId);
    } catch (error) {
      // Deadline during download: still resumable (poll of a COMPLETED export is free).
      if (isResumableEscape(error)) throw markDurable(error);
      // Other download failures: the export is COMPLETED; keep the "polling" marker so a later
      // request retries the download WITHOUT any new export.
      throw error;
    }
    // State 6 -- DURABLE completion. finishRows persists through the NORMAL source cache and
    // reports whether that persistence was POSITIVELY CONFIRMED ({ rows, persisted }). The marker
    // is removed ONLY on a confirmed durable save: in-memory caching alone is insufficient, and a
    // skipped/failed persist, a low deadline, an oversized payload, or cap-sized rows all leave
    // `persisted` false. In that case the "polling" marker (with its exportId) is RETAINED so a
    // later invocation resumes/re-downloads the SAME export with zero new create-export POSTs.
    const result = await finishRows(rows);
    const outRows = result && Object.prototype.hasOwnProperty.call(result, "rows") ? result.rows : result;
    const persisted = !!(result && result.persisted === true);
    if (persisted) {
      try { await store.remove(requestHash); } catch { /* best-effort: durable cache now serves this hash */ }
    }
    return outRows;
  }

  // The claim winner's create -> record exportId -> poll/download path.
  async function createAndRun(marker) {
    let created;
    try {
      created = await create(); // the ONLY create POST for this marker
    } catch (error) {
      if (isDefiniteCreateFailure(error)) {
        // DataDoe definitively rejected the POST: no export exists. Record the safe typed
        // code; the "failed" marker is re-claimable via CAS (state 7).
        await trySave({ ...markerBody("failed", null, safeCreateFailureCode(error), marker), rev: marker.rev });
        throw error;
      }
      // Ambiguous (deadline/abort/transport failure mid-POST): the export MAY exist. Leave the
      // "creating" marker untouched; it expires into the UNCERTAIN state and is never
      // auto-retried (state 8/9).
      throw error;
    }
    const exportId = norm(created && (created.exportId || created.id));
    if (!exportId) {
      // DataDoe answered without an id: treated as ambiguous -- leave "creating" (state 8).
      throw new Error("DataDoe create-export returned no export id.");
    }
    // Persist exportId with a rev-CAS BEFORE any polling (state 3). A CAS throw or loss means
    // the durable record of this export could not be established: fail closed, and never
    // auto-create for this marker again (state 8).
    const polling = { ...markerBody("polling", exportId, null, marker), rev: marker.rev };
    const won = await trySave(polling);
    if (won === false || won == null) throw uncertainErr();
    return resumePollDownload({ ...polling, rev: won }, { skipPoll: created.status === "COMPLETED" });
  }

  // ---- protocol entry ----
  let marker;
  try {
    marker = await store.load(requestHash);
  } catch {
    throw unavailableErr(); // cannot even read the claim state: fail closed BEFORE any POST
  }

  if (marker) {
    // Blocker 2: a loaded marker must match the current request identity in EVERY field before any
    // DataDoe call or any marker mutation. A missing/mismatched/malformed field fails closed here
    // (zero DataDoe calls, zero marker writes) rather than resuming, re-claiming, or creating.
    if (!markerIdentityMatches(marker, { requestHash, organizationFingerprint, sourceId })) {
      throw uncertainErr();
    }
    if (marker.status === "polling") {
      return resumePollDownload(marker); // state 5: resume the saved export; zero creates
    }
    if (marker.status === "creating") {
      const expiresAt = Date.parse(marker.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt > Date.now()) throw inProgressErr(); // state 2
      throw uncertainErr(); // state 9: owner died, create outcome unknown -- never auto-create
    }
    if (marker.status === "failed") {
      // State 7 follow-up: a DEFINITE create failure is safely re-claimable. CAS the marker
      // back to "creating"; the CAS loser never creates.
      let won;
      try {
        won = await store.save(requestHash, { ...markerBody("creating", null, null, marker), rev: marker.rev });
      } catch {
        throw unavailableErr();
      }
      if (won === false) throw inProgressErr();
      return createAndRun({ ...markerBody("creating", null, null, marker), rev: won });
    }
    throw uncertainErr(); // unknown status: fail closed
  }

  // State 1: no marker -- atomic INSERT-IF-ABSENT claim before any POST.
  const fresh = { ...markerBody("creating", null, null, null), rev: null };
  let claimed;
  try {
    claimed = await store.save(requestHash, fresh);
  } catch {
    throw unavailableErr(); // claim not durably written => NO create (fail closed)
  }
  if (claimed === false) throw inProgressErr(); // a concurrent first request won; zero POSTs here
  return createAndRun({ ...fresh, rev: claimed });
}

// Admin-safe fixed-shape code from a DEFINITE create failure: only the HTTP status digits are
// kept (the caller's isDefiniteCreateFailure guarantees the "(NNN)" shape); never raw text.
function safeCreateFailureCode(error) {
  const matched = /\((\d{3})\)/.exec(error instanceof Error ? error.message : String(error));
  return matched ? `CREATE_FAILED_${matched[1]}` : "CREATE_FAILED";
}
