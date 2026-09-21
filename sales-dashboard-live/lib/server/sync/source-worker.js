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
import { isRoutingScope } from "./scheduler-scope.js";
import { compactLatestInventorySnapshot, isLatestSnapshotSource } from "./fba-inventory-latest-snapshot.js";
import { isInitialLoadIncompleteMessage, READINESS_INCOMPLETE_CODE } from "./source-readiness-isolation.js";
import { ORGANIZATION_SCOPE_KEY } from "./source-durable-model.js";

const DEFAULT_RESERVE_MS = 3_000; // stop before the server cap so status/locks persist

function approxPayloadBytes(rows) {
  try { return Buffer.byteLength(JSON.stringify(rows ?? [])); } catch { return 0; }
}

// Capture a BOUNDED, SANITIZED snippet of a DataDoe error body for operator evidence. It redacts URLs,
// authorization/bearer/api-key/token/secret phrases, emails, UUIDs, and any long id/key-like token (export ids,
// seller ids, API keys), collapses whitespace, and truncates to `max` chars -- so a captured body carries a
// human-useful reason (e.g. "sellerOrVendorIds is required") but NEVER a secret, id, url, or key.
export function sanitizeErrorDetail(raw, max = 200) {
  let s = String(raw ?? "");
  s = s.replace(/^DataDoe[^:]*\(\d{3}\):\s*/i, ""); // drop our own "DataDoe ... (NNN): " prefix; keep the body
  s = s.replace(/\bhttps?:\/\/[^\s"']+/gi, "[redacted-url]");
  s = s.replace(/\b(authorization|bearer|api[_-]?key|token|secret|password)\b\s*[:=]?\s*\S+/gi, "$1 [redacted]");
  s = s.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[redacted-email]");
  s = s.replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, "[redacted-id]"); // uuid
  // long id/key/export tokens (16+ chars) but ONLY those that look like an identifier -- containing a digit,
  // underscore, or hyphen -- so a plain long word (e.g. "sellerOrVendorIds") survives as useful evidence.
  s = s.replace(/\b[A-Za-z0-9_-]{16,}\b/g, (m) => (/[0-9_-]/.test(m) ? "[redacted-id]" : m));
  // Amazon identifier shapes fall UNDER the 16+ rule: seller/vendor/marketplace tokens (start "A", 13-14 chars) and
  // ASINs (start "B0", 10 chars). Redact the id-shaped ones. The "A..." rule requires a DIGIT so a plain uppercase
  // reason word (e.g. AUTHORIZATION) is NOT redacted, while a real seller/marketplace id (which always carries digits)
  // is; ASINs are B0 + 8 (always a digit). Keeps useful provider reasons intact but never lets an Amazon id survive.
  s = s.replace(/\bA[A-Z0-9]{12,13}\b/g, (m) => (/[0-9]/.test(m) ? "[redacted-id]" : m));
  s = s.replace(/\bB0[A-Z0-9]{8}\b/g, "[redacted-id]");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > max) s = s.slice(0, max) + "...";
  return s;
}

// Map any DataDoe error to a SAFE classification for the given stage. The stored `message` is a fixed operator
// string — never the raw error, a URL, an id, or a key — and `detail` is a separately SANITIZED bounded body
// snippet for operator evidence. Classification distinguishes a DEFINITIVE client-side request rejection
// (HTTP 4xx except 408/429 -- terminal; a retry with the SAME request fails again) from the TRANSIENT /
// AMBIGUOUS classes (408 request-timeout, 429 rate-limit, 5xx, timeouts, and network ambiguity where a create
// POST may or may not have landed -- NEVER a definitive success). A definitive HTTP 400 is therefore never
// reported as an ambiguous or successful create; the durable reservation governs any resume (never a 2nd create).
export function classifyFetchError(error, stage = "create-export") {
  if (isDataDoeDeadlineError(error)) {
    return { stage, code: "TIMEOUT", message: "DataDoe work deferred at the execution deadline.", terminal: false, transient: true };
  }
  // Defensive: the typed poll-window-exhausted signal is normally intercepted as a resumable
  // deferral BEFORE classification (an export_id always exists at the poll stage). If it ever
  // reaches classification anyway it must stay non-terminal so the export can still be resumed.
  if (isDataDoePollPendingError(error)) {
    return { stage, code: "POLL_PENDING", message: "DataDoe export still processing at the end of the bounded poll window; resumable.", terminal: false, transient: true };
  }
  if (isSourceDisabledError(error)) {
    return { stage, code: "SOURCE_DISABLED", message: "Source is disabled for this organization.", terminal: true, transient: false };
  }
  // The ZERO-EXPORT reconciler's no-export inner adapter refused a create/poll/download (error.code NO_EXPORT_REQUIRED):
  // the durable source it needs is not adoptable THIS pass. That is a routine, next-cycle-resolvable readiness gap, NOT a
  // required-source FAILURE -- classify it as the retryable SOURCE_READINESS_PENDING so the family stop defers
  // (DEFERRED_DEPENDENCY, LKG preserved) instead of hard-failing. This code is emitted ONLY on the reconciler path (the
  // real DataDoe adapter never throws NO_EXPORT_REQUIRED), so the scheduled full-region behavior is byte-identical.
  if (error && error.code === "NO_EXPORT_REQUIRED") {
    return { stage, code: "SOURCE_READINESS_PENDING", message: "The zero-export reconciler will not create/poll/download a DataDoe export; the durable source is not adoptable this pass, so it is deferred (never a create).", terminal: false, transient: true };
  }
  const raw = error instanceof Error ? error.message : String(error);
  const detail = sanitizeErrorDetail(raw);
  const matched = raw.match(/\((\d{3})\)/);
  if (matched) {
    const status = Number(matched[1]);
    if (status >= 400 && status <= 599) {
      // 408 Request Timeout + 429 Too Many Requests + every 5xx are TRANSIENT (resumable); every OTHER 4xx is a
      // DEFINITIVE client-side request rejection (terminal -- the SAME request will be rejected again).
      const transient = status === 408 || status === 429 || status >= 500;
      // NARROW readiness rejection: DataDoe hard-rejects a seller-batched export with HTTP 400 when even ONE
      // selected seller's Seller Central initial data load is incomplete ("... requires Seller Central data on
      // every selected seller, but the initial data load is not complete."). It is STILL terminal for THIS exact
      // batch (the same request re-fails), but a DISTINCT typed code so a later fresh cycle can isolate the batch
      // into single-seller jobs (healthy sellers stop being poisoned). Matched ONLY on the proven provider
      // signature -- every other terminal 400 stays HTTP_400 and never triggers a split.
      if (status === 400 && isInitialLoadIncompleteMessage(raw)) {
        return { stage, code: READINESS_INCOMPLETE_CODE, message: "DataDoe rejected this export: a selected seller's Seller Central initial data load is not complete.", terminal: true, httpStatus: 400, transient: false, detail };
      }
      return { stage, code: `HTTP_${status}`, message: `DataDoe returned HTTP ${status} for this source.`, terminal: !transient, httpStatus: status, transient, detail };
    }
  }
  if (/timed out/i.test(raw)) {
    return { stage, code: "TIMEOUT", message: "DataDoe export timed out while processing.", terminal: false, transient: true, detail };
  }
  // A network-layer failure with NO HTTP status is AMBIGUOUS (the create POST may or may not have landed): it is
  // NEVER a definitive success and stays non-terminal so the durable reservation governs any resume.
  if (/\bnetwork\b|fetch failed|ECONNRESET|socket hang ?up|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|aborted/i.test(raw)) {
    return { stage, code: "NETWORK_AMBIGUOUS", message: "DataDoe request failed at the network layer; the create outcome is ambiguous (resumable via the durable reservation, never a second create).", terminal: false, transient: true, detail };
  }
  return { stage, code: "EXPORT_ERROR", message: "DataDoe export failed for this source.", terminal: false, transient: true, detail };
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
 * Is a RECORDED source failure the exact, narrow shape a DOWNLOAD-ONLY recovery may resume? Eligible ONLY when
 * the job already CREATED its one export and failed at a TRANSIENT poll/download stage -- so the recovery can
 * re-poll/re-download the SAME saved export_id and NEVER issue a second create-export. A terminal failure, a
 * TRUNCATED/validate/persist failure, a create-export-stage failure, a job with no created export (count!=1),
 * or a missing/blank export_id is NOT eligible (never retried, never re-created). Pure; reads only the row.
 */
export function recoveryEligibility(jobRow) {
  const status = fetchStatusOf(jobRow);
  const terminal = (jobRow.terminal ?? false) === true;
  const stage = jobRow.error_stage ?? jobRow.errorStage ?? "";
  const createCount = Number(jobRow.create_export_count ?? jobRow.createExportCount ?? 0);
  const exportId = jobRow.export_id ?? jobRow.exportId ?? null;
  if (status !== "failed") return { eligible: false, reason: "not-failed" };
  if (terminal) return { eligible: false, reason: "terminal" };
  if (stage !== "poll" && stage !== "download") return { eligible: false, reason: "stage-not-recoverable" };
  if (createCount !== 1) return { eligible: false, reason: "create-count-not-one" };
  if (typeof exportId !== "string" || exportId.trim() === "") return { eligible: false, reason: "missing-export-id" };
  // The saved export id must be CANONICAL: a whitespace-padded / noncanonical id is REJECTED (never trimmed),
  // so a recovery can only ever bind to the exact stored id (the claim PATCH filters on it verbatim).
  if (exportId !== exportId.trim()) return { eligible: false, reason: "noncanonical-export-id" };
  return { eligible: true, exportId };
}

/**
 * Run ONE source job through the resumable lifecycle. Returns an outcome for signal
 * derivation. Never throws for an expected source failure — it records a safe failure and
 * returns a non-success outcome so the cycle continues.
 */
async function runJobLifecycle({ store, dataDoe, clock, cycleId, job, progress, runWithDeadline, reuseOnly = false, completeUnavailableOnMissingReuse = false, budget = null, forceFreshOli = false }) {
  const requestHash = job.requestHash;
  const requestKey = job.requestKey || "";
  const started = clock();
  const status = job.fetch_status;
  let exportId = job.export_id || null;

  const fail = async (stage, code, message, terminal, rowCount, detail) => {
    // PRESERVE the sanitized, secret-free provider detail (from classifyFetchError) alongside the fixed operator
    // message, so an operator can see WHY DataDoe rejected a create/poll/download (e.g. the provider's own reason)
    // instead of only "DataDoe returned HTTP 400 for this source." No schema change: the detail is appended to the
    // stored error_message (already bounded + sanitized upstream). Never a URL, id, key, or raw body.
    const d = detail == null ? "" : String(detail).trim();
    const stored = d && d !== String(message).trim() ? `${message} :: provider: ${d}` : message;
    await store.recordSourceFailure({ cycleId, requestHash, exportId, stage, code, message: stored, terminal, durationMs: clock() - started, rowCount });
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
    // FORCE-FRESH-OLI: skip the durable exact-cache adoption for a PENDING order-line-items job so a stale
    // (but TTL-valid) earlier payload for the SAME request_hash is NEVER reused -- the job falls through to a real
    // create-export POST (below), genuinely re-querying DataDoe for the newly-settled D-1 rows. Only OLI is force-
    // refreshed; every other family keeps the reviewed cache-reuse path unchanged.
    const skipCacheAdoption = forceFreshOli && job.sourceKey === "order-line-items";
    if (typeof store.loadSourceRows === "function" && !skipCacheAdoption) {
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
        && (!job.freshnessNotBefore || Date.parse(entry.fetched_at ?? entry.fetchedAt ?? "") >= Date.parse(job.freshnessNotBefore))
        && (!job.marketplacePairs || validateBatchSourcePayload({ rows: cachedRows, sellerOrVendorIds: job.fetchParams?.sellerOrVendorIds,
          sourceScope: job.sourceScope, marketplaceScoped: job.marketplaceScoped, marketplacePairs: job.marketplacePairs }).valid)
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
    // DR1 -- DURABLE CATALOG EVIDENCE ADOPTION. When the org Product Catalog job cannot be exported (the zero-export
    // reconciler's noExport adapter) and the 24h export cache was cold (not adopted above), satisfy the Catalog
    // dependency from the VALIDATED durable source_snapshots snapshot -- the SAME canonical evidence the read-path
    // self-heal derives from -- so OLI-dependent publication converges with ZERO export instead of deferring. It NEVER
    // fabricates success: the durable snapshot must prove EXACT equivalence to THIS job's canonical request
    // (source_request_hash == request_hash), carry the exact object_path + payload_sha the worker validated, and be
    // validated evidence; any mismatch/stale/absent snapshot falls through to the normal (deferring) path. The
    // adoption is an atomic CAS with EXPLICIT provenance (adoption_kind='durable_snapshot'); a concurrent real export
    // wins (fetch_status='pending' predicate). The SCHEDULED full-region adapter has no noExport flag, so this branch
    // never fires for it -- it still re-EXPORTS the Catalog daily (fetch obligation unchanged), byte-identical.
    // Reversible kill-switch (expand-first / canary safety): DURABLE_CATALOG_ADOPTION=off disables the new path
    // entirely (the reconciler reverts to deferring on a cold cache) WITHOUT a code revert or dropping the migration.
    if (String(process.env.DURABLE_CATALOG_ADOPTION || "on").toLowerCase() !== "off"
        && job.sourceKey === "product-catalog" && dataDoe && dataDoe.noExport === true
        && typeof store.adoptDurableCatalogSnapshot === "function" && typeof store.readDurableCatalogSnapshot === "function") {
      let snap = null;
      try {
        const snapRead = await store.readDurableCatalogSnapshot({
          organizationFingerprint: job.organizationFingerprint, connectionId: job.connectionId || "primary",
          sourceKey: "product-catalog", scopeKey: ORGANIZATION_SCOPE_KEY,
        });
        snap = snapRead && snapRead.read === "ok" ? snapRead.snapshot : null;
      } catch (_e) { snap = null; }
      // Fail-fast evidence gate (re-validated authoritatively inside the CAS): the org's ONE canonical product-catalog
      // snapshot for THIS tenant/scope must exist, carry a content hash (object_path + payload_sha) the CAS will match,
      // and be validated. The export request_hash is NOT the basis (the org catalog is date-independent content the
      // derive reads directly); the snapshot is compatible evidence for any product-catalog job of the same tenant.
      if (snap && String(snap.object_path || "").trim() !== "" && String(snap.payload_sha || "").trim() !== "" && snap.validated_at) {
        // Fail-soft: any adoption error (e.g. the RPC is not yet deployed under expand-first rollout, or a transient
        // read error) is treated as "did not adopt" -> fall through to the normal (deferring) path. NEVER a crash and
        // NEVER a fabricated success -- only a typed 'adopted' ack ever marks the job succeeded.
        let ack = null;
        try {
          ack = await store.adoptDurableCatalogSnapshot({
            cycleId, requestHash,
            organizationFingerprint: job.organizationFingerprint, connectionId: job.connectionId || "primary",
            sourceKey: "product-catalog", scopeKey: ORGANIZATION_SCOPE_KEY,
            objectPath: snap.object_path, payloadSha: snap.payload_sha, minValidatedAt: null,
          });
        } catch (_e) { ack = null; }
        if (ack === "adopted") {
          progress.succeeded += 1;
          return { requestKey, requestHash, status: "success", validated: true, rowCount: (typeof snap.row_count === "number" ? snap.row_count : null), reused: true, adoption: "durable_snapshot" };
        }
        if (ack === "not-adopted") {
          // A real export / warm-cache adoption concurrently WON the pending->succeeded transition -> the real
          // evidence wins; a fresh invocation re-reads the true status and resumes/skips. Never a second create.
          progress.skipped += 1;
          return { requestKey, requestHash, status: "skipped", validated: false, reason: "durable-adopt-not-won" };
        }
        // 'snapshot-missing' | 'snapshot-mismatch' | 'snapshot-stale' -> the durable evidence is not adoptable; fall
        // through to the normal path (which, for the noExport reconciler, defers retryably as before). Fail closed.
      }
    }
    // Blocker 3: reuseOnly REHEARSAL gate. No durable exact cache entry was adopted above, and a pending
    // job has no saved export_id to resume, so this source is NOT reusable. A rehearsal pass must create
    // ZERO exports: leave the job pending (blocked, NOT failed), record nothing durable, and return a
    // typed MISSING_REUSABLE_SOURCE outcome as evidence. The create-export POST is never reached.
    if (reuseOnly) {
      progress.missingReusable += 1;
      // OPTIONAL-SOURCE variant (v3 inventory Pass 2): when this reuse-only source is OPTIONAL, a missing adoptable
      // cache is recorded COMPLETE-AS-UNAVAILABLE (fetch_status='skipped', terminal) instead of left pending, so the
      // dedicated cycle can DRAIN + finalize 'succeeded' for the accounts whose required listings/OLI published while
      // inventory stays honestly unavailable for the FBA-failed accounts. Still ZERO creates -- the POST is never
      // reached. Default (flag false) is byte-identical to the rehearsal gate: leave the job pending, record nothing.
      if (completeUnavailableOnMissingReuse && typeof store.recordSourceSkipped === "function") {
        await store.recordSourceSkipped({ cycleId, requestHash, code: "MISSING_REUSABLE_SOURCE", message: "Reuse-only optional source has no adoptable cache; recorded complete-as-unavailable." });
        progress.completeUnavailable = (progress.completeUnavailable || 0) + 1;
        return { requestKey, requestHash, status: "complete-unavailable", validated: false, skipped: true, code: "MISSING_REUSABLE_SOURCE" };
      }
      return { requestKey, requestHash, status: "missing-reusable-source", validated: false, code: "MISSING_REUSABLE_SOURCE" };
    }
    // Blocker 4d: when a FROZEN tranche budget is active, the create-claim goes through the ATOMIC pre-POST
    // reservation (reserve_source_export_create) instead of the plain claim -- it claims the still-pending job
    // AND reserves the create + AI-token cost in one transaction, so only the reservation winner may POST and
    // neither ceiling can be exceeded (even by concurrent workers). Cache adoption, a saved-export_id resume,
    // and reuseOnly all return BEFORE this point, so they spend ZERO creates/tokens. A drifted plan or an
    // exhausted ceiling ABORTS before the POST with a typed safe outcome and no retry/fallback.
    let won;
    if (budget && typeof store.reserveExportCreate === "function") {
      const ack = await store.reserveExportCreate({ cycleId, trancheKey: budget.trancheKey, requestHash, planFingerprint: budget.planFingerprint });
      if (ack === "reserved") {
        won = true;
      } else if (ack === "not-pending") {
        won = false;
      } else if (ack === "plan-mismatch") {
        return fail("reserve", "PLAN_BUDGET_MISMATCH", "This source is not in the frozen tranche plan (plan/pricing drift); refusing to create (fail closed).", true);
      } else if (ack === "budget-exceeded") {
        return fail("reserve", "TOKEN_BUDGET_EXCEEDED", "The frozen tranche create/token ceiling is reached; refusing to create (fail closed).", true);
      } else {
        return fail("reserve", "RESERVE_ACK_MALFORMED", "The pre-POST reservation returned a malformed acknowledgement; refusing to create (fail closed).", true);
      }
    } else {
      won = await store.claimExportAttempt(cycleId, requestHash);
    }
    if (!won) { progress.skipped += 1; return { requestKey, requestHash, status: "skipped", validated: false, reason: "already-attempted" }; }
    progress.attemptsWon += 1;
    try {
      const created = await runWithDeadline(() => dataDoe.create(job)); // exactly one POST
      exportId = created && created.exportId ? created.exportId : null;
    } catch (error) {
      const cls = classifyFetchError(error, "create-export");
      return fail(cls.stage, cls.code, cls.message, cls.terminal, undefined, cls.detail);
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
    return fail(cls.stage, cls.code, cls.message, cls.terminal, undefined, cls.detail);
  }

  // ---- STEP 5: download ----
  let rows;
  try {
    rows = await runWithDeadline(() => dataDoe.download(job, exportId));
  } catch (error) {
    const deferral = deferIfResumable(error, "download");
    if (deferral) return deferral; // resumable: job stays attempted + export_id
    const cls = classifyFetchError(error, "download");
    return fail(cls.stage, cls.code, cls.message, cls.terminal, undefined, cls.detail);
  }

  // ---- STEP 6: validate. A non-array payload is a failure (never coerced to []); a
  // strict job at/above its row cap is a truncation failure. Neither is saved. ----
  if (!Array.isArray(rows)) {
    return fail("validate", "MALFORMED_PAYLOAD", "DataDoe payload was not an array; result not saved.", true);
  }
  // LATEST-SNAPSHOT normalization exception: a SINGLE-seller inventory payload from a contract EXPLICITLY marked
  // `latestSnapshot` (fba-plan:inventory-health + listing-health-v3:inventory -- FBA Plan + Listing Health v3 consume
  // only the latest inventory date) is reduced to its latest PROVABLY-COMPLETE date so an oversized/cap-sized payload
  // fits the row cap + 8MB cache limit -- NEVER summing across dates. Gated by BOTH the contract flag AND the inventory
  // source key (defense in depth) AND a single seller; EVERY other source (the insight reports' own inventory contract
  // with different columns/limit, OLI, Ads, catalog, ...) and any multi-seller batch keep the generic strict TRUNCATED
  // validator below unchanged. An unprovable latest date is a terminal validate failure (never inferred complete). The
  // contract's own row limit is the cap (so a 50000-row inventory export is judged against 50000, never a default).
  const fpLs = job.fetchParams || {};
  const lsIds = Array.isArray(fpLs.sellerOrVendorIds) ? fpLs.sellerOrVendorIds : [];
  const isLatestSnapshotSingle = job.latestSnapshot === true && isLatestSnapshotSource(job.sourceKey) && lsIds.length === 1;
  let rowsToPersist = rows;
  let latestSnapshotMeta = null;
  if (isLatestSnapshotSingle) {
    const compacted = compactLatestInventorySnapshot({
      rows, seller: lsIds[0],
      marketplace: job.marketplaceConstraint ?? (Array.isArray(job.marketplacePairs) && job.marketplacePairs[0] && job.marketplacePairs[0].marketplace) ?? null,
      rowCap: Number(job.limit) > 0 ? Number(job.limit) : undefined,
      exportRef: exportId, requestedFrom: fpLs.from, requestedTo: fpLs.to,
    });
    if (!compacted.complete) {
      return fail("validate", "LATEST_SNAPSHOT_INCOMPLETE", "Latest inventory date is not provably complete; not saved (previous data preserved).", true, rows.length);
    }
    rowsToPersist = compacted.rows;
    latestSnapshotMeta = compacted.metadata;
  } else if (job.strict === true && rows.length >= Number(job.limit)) {
    return fail("validate", "TRUNCATED", "Result reached the row cap; partial data was not saved.", true, rows.length);
  }

  // ---- Blocker 4c: BATCH INTEGRITY. A DECLARED seller-scoped source fetched over a <=5-account BATCH (more
  // than one canonical seller id) must contain ONLY rows for those exact sellers -- and, when the contract
  // fetched marketplace_country_code, ONLY the batch's canonical marketplace -- so ONE canonical payload can be
  // split back per account at derive time. Reject the WHOLE batch (never saved) on any malformed row, blank/
  // unknown/cross-account seller id, or blank/mismatched marketplace; a zero-row batch stays valid-empty. A
  // single-account source (<=1 id) and an organization-scoped source (e.g. Product Catalog) are unaffected.
  // The scope + marketplace expectation come from the IMMUTABLE planned metadata (Findings 2 & 3), never a
  // column heuristic; an unknown/missing scope on a batch fails closed. ----
  const fp = job.fetchParams || {};
  const batchIds = Array.isArray(fp.sellerOrVendorIds) ? fp.sellerOrVendorIds : [];
  if (batchIds.length > 1 || job.marketplacePairs) {
    // Validate the rows that will ACTUALLY be persisted (the compacted latest-date block for a latest-snapshot single
    // seller; the raw rows otherwise) so a cross-account/marketplace row can never be saved.
    const bv = validateBatchSourcePayload({
      rows: rowsToPersist,
      sellerOrVendorIds: batchIds,
      sourceScope: job.sourceScope,
      marketplaceScoped: job.marketplaceScoped === true,
      marketplaceCountry: job.marketplaceConstraint ?? null,
      marketplacePairs: job.marketplacePairs ?? null,
    });
    if (!bv.valid) {
      return fail("validate", bv.code || "BATCH_INVALID", bv.reason || "Batch payload failed per-account integrity validation; result not saved.", true, rows.length);
    }
  }

  // ---- STEP 7: persist (atomic last-known-good). A save error / empty object path is a
  // SEPARATE persist-stage failure and never overwrites the previous good data. ----
  // A latest-snapshot job persists the COMPACTED latest-date block + records the normalization provenance in the cache
  // row's request_meta (so an old full-range cache can never be mistaken for a normalized latest-snapshot cache); the
  // request_hash is UNCHANGED (only the stored payload + metadata differ), so no unrelated identity moves.
  const persistJob = latestSnapshotMeta
    ? { ...job, request_meta: { ...(job.request_meta ?? job.requestMeta ?? {}), ...latestSnapshotMeta } }
    : job;
  const payloadBytes = approxPayloadBytes(rowsToPersist);
  let saveResult;
  try {
    saveResult = await store.saveSourceRows({ job: persistJob, rows: rowsToPersist, payloadBytes, exportId, version: `${cycleId}-${exportId}` });
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
  const savedRows = saveResult && Array.isArray(saveResult.rows) ? saveResult.rows : rowsToPersist;
  const savedRowCount = saveResult && typeof saveResult.rowCount === "number" ? saveResult.rowCount : rowsToPersist.length;
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
 * DOWNLOAD-ONLY recovery of ONE already-created export whose recorded failure is the exact recoverable shape
 * (recoveryEligibility). It NEVER creates an export. The smallest production-safe step:
 *   1. gate on recoveryEligibility (in-memory) -- an ineligible job is a no-op skip, never re-created;
 *   2. ATOMICALLY claim the recovery via store.claimSourceExportRecovery -- a compare-and-set that flips the
 *      still-'failed' row to 'attempted' (preserving export_id AND create_export_count, so the one-create-per-
 *      hash invariant holds). Exactly ONE concurrent caller wins ('claimed'); a loser sees 'not-eligible' and
 *      skips (no duplicate download/write). ANY non-'claimed'/malformed acknowledgement FAILS CLOSED (skip);
 *   3. resume the SAME export_id through the EXISTING poll -> download -> validate -> save(CAS) -> success path
 *      (runJobLifecycle on an 'attempted' job never creates), so the exact seller/account/marketplace tuple
 *      validator, the truncation + row-integrity + currency checks, the source-cache CAS, and the guarded
 *      success path all apply unchanged. A poll/download at most once per invocation. A validation/persist
 *      failure records a safe (possibly terminal) failure and preserves last-known-good -- never fabricates.
 * Returns the resume outcome, or a typed { status: "recovery-skipped", reason } when not eligible / not won /
 * ambiguous. `meta` is the canonical plan entry; `jobRow` the authoritative DB row.
 */
export async function recoverFailedDownloadJob({ store, dataDoe, clock = () => Date.now(), cycleId, meta, jobRow, runWithDeadline, progress = null }) {
  const requestHash = jobRow.request_hash ?? jobRow.requestHash;
  const requestKey = (meta && meta.requestKey) || jobRow.request_key || "";
  const prog = progress || { succeeded: 0, failed: 0, skipped: 0, deferred: 0, attemptsWon: 0, missingReusable: 0, processed: 0 };
  const skip = (reason) => ({ requestKey, requestHash, status: "recovery-skipped", validated: false, reason });

  const elig = recoveryEligibility(jobRow);
  if (!elig.eligible) return skip(elig.reason);
  if (typeof store.claimSourceExportRecovery !== "function") return skip("recovery-cas-unavailable");

  // Atomic recovery claim (failed -> attempted), BOUND to the exact saved export id. NEVER a create-export.
  let ack;
  try {
    ack = await store.claimSourceExportRecovery({ cycleId, requestHash, expectedExportId: elig.exportId });
  } catch (_e) {
    // A commit-unknown / errored claim is NEVER reported as committed or success: a fresh invocation re-reads
    // the authoritative row (which, if the claim DID commit, is now 'attempted' and resumes via the normal
    // path) -- this recovery attempt records nothing and fabricates nothing.
    return skip("recovery-claim-error"); // fail closed: no download, no fabrication
  }
  if (ack === "not-eligible" || ack === "not-won") return skip(ack);
  if (ack !== "claimed") return skip("recovery-ack-ambiguous"); // fail closed on any malformed/unknown ack

  // Claimed: the row is now 'attempted' with its saved export_id. Resume download-only via the exact existing
  // lifecycle (create is unreachable for an 'attempted' job with a saved export_id).
  const resumeJob = { ...mergeJob(meta || {}, jobRow), fetch_status: "attempted", export_id: elig.exportId };
  const outcome = await runJobLifecycle({ store, dataDoe, clock, cycleId, job: resumeJob, progress: prog, runWithDeadline, reuseOnly: false, budget: null });
  return outcome || skip("recovery-noop");
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
  // BUILD-TIME OPTIONAL-SOURCE flag (v3 inventory Pass 2). Only meaningful with reuseOnly: when true, a reuse-only
  // job with no adoptable cache is recorded COMPLETE-AS-UNAVAILABLE (fetch_status='skipped', terminal) instead of
  // left pending, so an OPTIONAL source (v3 FBA inventory) never blocks the cycle from draining/finalizing while its
  // dependent fields stay unavailable. Default false => byte-identical to the rehearsal gate. NEVER a per-run arg.
  completeUnavailableOnMissingReuse = false,
  // Blocker 4d: the FROZEN tranche budget context `{ trancheKey, planFingerprint }` (persisted before this
  // invocation). When present, every create-export goes through the atomic pre-POST reservation
  // (store.reserveExportCreate) so the create/AI-token ceilings can never be exceeded. null => the legacy
  // one-attempt claim (behavior unchanged). NEVER a per-run/untrusted argument.
  budget = null,
  // DOWNLOAD-ONLY recovery flag (opt-in). false (default) => a recorded failure is durable LKG and is left
  // untouched (byte-identical to before). true => an owned+planned job whose failure is the exact recoverable
  // shape (recoveryEligibility: non-terminal poll/download failure of an already-created export) is resumed
  // download-only (recoverFailedDownloadJob) -- claim failed -> attempted, then poll/download the SAME export_id
  // once and validate/save/success through the existing paths. NEVER re-creates; a terminal/TRUNCATED/create-
  // stage failure is never eligible. NEVER a per-run/untrusted argument (a build-time composition flag).
  recoverFailedDownloads = false,
  // FORCE-FRESH-OLI flag (the previous-day "force latest" fresh-fetch). When true, a PENDING order-line-items job
  // SKIPS the durable exact-cache adoption (Part C) so a stale-but-TTL-valid earlier payload for the SAME canonical
  // request_hash is NOT reused -- the job falls through to the reservation/claim -> real dataDoe.create() POST, so
  // DataDoe is genuinely re-queried for the newly-settled D-1 rows. The request_hash is UNCHANGED (identity has no
  // run-scoped input); only the execution-time reuse decision is overridden. Idempotency across runs is the caller's
  // durable freshness reservation, not this flag. NEVER a per-run/untrusted argument (a build-time composition flag).
  forceFreshOli = false,
  // The pre-resolved ACTIVE cycle id (the caller resolved the superseding/running head ONCE so the frozen budget
  // and the create-reservation share one cycle). When provided it is used verbatim (still claimed); when null, this
  // function resolves the head itself, falling back to opening a fresh BASE cycle.
  cycleId: providedCycleId = null,
  // OPTIONAL cycle-bucket NAMESPACE (defaults to `bucket`, so the scheduler-v2 path is byte-identical). A dedicated
  // operator (the FBA Plan go-live/refresh) passes a distinct namespace (e.g. "us-fba") so its sync_cycles row NEVER
  // collides with the scheduler-v2 daily (bucket, cycle_date) cycle. Account scope + EVERY validation still use the
  // real `bucket`; ONLY the cycle key (getCycleByBucketDate + openCycle) is namespaced.
  cycleBucket = null,
}) {
  if (!isRoutingScope(bucket)) throw new Error("bucket must be a routing scope (india|europe-au|us-ca|us|non-us).");
  const progress = {
    cycleId: null, claimedCycle: false, alreadyFinished: false,
    planned: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0, attemptsWon: 0, deferred: 0,
    missingReusable: 0, deadlineReached: false, drained: false,
  };
  const outcomes = [];
  const runWithDeadline = (fn) => withDataDoeDeadline(deadlineMs === Infinity ? Infinity : deadlineMs - reserveMs, fn);

  // Head-aware cycle resolution: prefer the caller's pre-resolved ACTIVE cycle id (so the budget + reservation share
  // one cycle). Otherwise, when a running/pending head already exists for the slot -- a base cycle in progress OR a
  // superseding attempt an operator created to take over a stale terminal slot -- resume THAT cycle instead of
  // re-opening the base (which would re-select the immutable terminal cycle). Only when neither exists is a fresh
  // BASE cycle created. The head read is a plain read (safe to abort); openCycle stays a pure write.
  const cycleKeyBucket = cycleBucket || bucket; // the namespaced cycle key (fba-plan) or the real bucket (scheduler-v2)
  let cycleId = providedCycleId;
  if (!cycleId) {
    let head = null;
    if (typeof store.getCycleByBucketDate === "function") {
      try { head = await store.getCycleByBucketDate(cycleKeyBucket, cycleDate); } catch (_e) { head = null; }
    }
    cycleId = head && head.id && ["running", "pending"].includes(String(head.status))
      ? head.id
      : await store.openCycle({ bucket: cycleKeyBucket, cycleDate, scheduledAt, trigger });
  }
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
    if (st === "succeeded" || st === "skipped") continue; // done (a shared hash already fetched is read, not re-run)
    if (st === "failed") {
      // A recorded failure is durable last-known-good and is left untouched -- UNLESS download-only recovery is
      // enabled AND this is the exact recoverable shape (non-terminal poll/download failure of an already-created
      // export). Then resume the SAME export_id download-only; NEVER re-create. A terminal / TRUNCATED / validate
      // / persist / create-stage failure is never eligible and stays failed (LKG preserved).
      const failedMeta = metaByHash.get(hash);
      if (recoverFailedDownloads && failedMeta && recoveryEligibility(jobRow).eligible) {
        if (progress.processed >= maxJobs) break;
        if (clock() >= deadlineMs - reserveMs) { progress.deadlineReached = true; break; }
        progress.processed += 1;
        const outcome = await recoverFailedDownloadJob({ store, dataDoe, clock, cycleId, meta: failedMeta, jobRow, runWithDeadline, progress });
        if (outcome) outcomes.push(outcome);
      }
      continue;
    }
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
    const outcome = await runJobLifecycle({ store, dataDoe, clock, cycleId, job, progress, runWithDeadline, reuseOnly, completeUnavailableOnMissingReuse, budget, forceFreshOli });
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
