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
import { MAX_SNAPSHOT_BYTES, snapshotByteSize } from "../report-limits.js";
import { isolateFragmentRowsForOwner, isBatchedSellerFragment, missingOwnerFields } from "./source-account-isolation.js";
// Strict UTC calendar-date rule (rejects 2026-02-30 / 2026-99-99 / 2023-02-29; accepts
// 2024-02-29), reused from the contracts leaf so there is one implementation.
import { isValidCalendarDate } from "./report-source-contracts.js";

// A report job is finished when it derived AND saved (or was terminally blocked). Finished
// jobs are never re-derived (idempotent across repeated worker invocations).
function reportFinished(jobRow) {
  const fetchS = jobRow.fetch_status ?? jobRow.fetchStatus ?? "pending";
  const derive = jobRow.derive_status ?? jobRow.deriveStatus ?? "pending";
  const save = jobRow.save_status ?? jobRow.saveStatus ?? "pending";
  if (fetchS === "blocked") return true; // terminally blocked this cycle (derive/save skipped)
  if (derive === "succeeded" && save === "succeeded") return true;
  if (derive === "failed" || derive === "skipped") return true; // not retried in-cycle
  if (save === "failed") return true; // save failed this cycle; a NEW cycle re-derives
  return false;
}

// Normalize any date/timestamp to a STRICT YYYY-MM-DD (or null). Beyond the shape, the sliced
// date must be a real calendar date (UTC round-trip via isValidCalendarDate), so an impossible
// date (2026-02-30, 2026-99-99, non-leap 2023-02-29) is rejected rather than written to the
// Postgres `date` column. A valid ISO timestamp's date portion is accepted.
function toDateOnly(value) {
  if (!value) return null;
  const s = String(value).slice(0, 10);
  return isValidCalendarDate(s) ? s : null;
}

// Scope keys that define the PLANNED report identity/scope. A derive-only injected input may NEVER
// set any of these, even if a report allowlists them by mistake: the planned scope is authoritative
// and the snapshot key is computed from it, so a derived override here would let injected data
// diverge from what the snapshot claims. Enforced in buildDeriveContext (defense-in-depth).
const RESERVED_CONTEXT_KEYS = new Set([
  "accountId", "account", "rawSellerId", "brand", "from", "to", "params", "version", "reportVersion",
  "retrievedAt", "context", "sources",
]);

/**
 * Build the pure derivation context FAIL-CLOSED (Blocker 1):
 *  - the PLANNED context (account/brand/from/to/...) is authoritative and always wins;
 *  - a derive-only injected input contributes ONLY the field names this report explicitly
 *    allowlists (`entry.derivedContextKeys`) AND that are not reserved scope keys -- every other
 *    field (unexpected, malformed, or a scope-override attempt) is dropped deterministically;
 *  - a non-object / array derivedContext is treated as no derived input (never spread field-wise);
 *  - accountId and retrievedAt are pinned last from authoritative sources (plan/source metadata),
 *    never Date.now().
 * So injected data can add approved derive-only inputs (e.g. Daily's typed Ads coverage) but can
 * never replace the planned account, brand, or date scope that the snapshot identity is built from.
 */
export function buildDeriveContext({ entry, plannedContext, derivedContext, accountId, latestFetchedAt }) {
  const planned = (plannedContext && typeof plannedContext === "object" && !Array.isArray(plannedContext)) ? plannedContext : {};
  const allow = new Set((entry && entry.derivedContextKeys) || []);
  const safeDerived = {};
  if (derivedContext && typeof derivedContext === "object" && !Array.isArray(derivedContext)) {
    for (const k of Object.keys(derivedContext)) {
      if (!allow.has(k)) continue;               // unexpected/unapproved derived field: ignore
      if (RESERVED_CONTEXT_KEYS.has(k)) continue; // never allow a scope override, even if allowlisted
      safeDerived[k] = derivedContext[k];
    }
  }
  // Spread the approved derived inputs FIRST, then the planned scope so the plan always wins, then
  // pin accountId + retrievedAt from authoritative sources.
  return {
    ...safeDerived,
    ...planned,
    accountId,
    retrievedAt: (planned.retrievedAt) || latestFetchedAt || null,
  };
}

async function runOneReport({ store, cycleId, sourceRows, saveSnapshot, planned, statusByHash, errorByHash = {}, clock, maxSnapshotBytes, loadDerivedContext }) {
  const { reportKey, accountId } = planned;
  const started = clock();
  const entry = REPORT_DERIVATIONS[reportKey];
  const fail = async (stage, code, message, terminal = false) => {
    await store.recordReportFailure({ cycleId, reportKey, accountId, stage, code, message, terminal, durationMs: clock() - started });
    return { reportKey, accountId, status: "failed", stage, code };
  };

  const required = planned.sources.filter((s) => !s.optional);
  const requiredHashes = required.map((s) => s.requestHash);

  // 1) FETCH gate: are ALL required source fragments saved? (Optional/degraded never block.)
  //    Multi-chunk / multi-window keys contribute one hash per fragment, so the gate needs
  //    every chunk succeeded.
  const gate = reportFetchGate({ dependsOn: requiredHashes }, statusByHash);
  if (gate === "pending") {
    return { reportKey, accountId, status: "pending" };
  }
  if (gate === "blocked") {
    // A required source failed/was skipped: block THIS report TERMINALLY for the cycle;
    // preserve last-known-good.
    await store.recordReportBlocked({ cycleId, reportKey, accountId, reason: "required source failed or skipped" });
    return { reportKey, accountId, status: "blocked" };
  }

  // 2) Claim derive exactly once (guarded pending -> running). Lose it => another worker owns it.
  const won = await store.claimReportDerive(cycleId, reportKey, accountId);
  if (!won) return { reportKey, accountId, status: "skipped", reason: "derive already claimed" };

  // 3) Load each request-hash payload from the cache (never a DataDoe export) and assemble
  //    the fragment-preserving `sources` map (see assembleSources).
  const loadedByHash = new Map();
  for (const s of planned.sources) {
    if (statusByHash[s.requestHash] !== "succeeded" || loadedByHash.has(s.requestHash)) continue;
    let payload = null;
    try { payload = await sourceRows(s.requestHash); } catch (_e) { payload = null; }
    loadedByHash.set(s.requestHash, payload);
  }
  // Blocker 4c (correction, Finding 1): a report that depends on a BATCHED seller-scoped source (a declared
  // seller source covering >1 canonical seller id) MUST carry COMPLETE authoritative owner metadata
  // (accountId, rawSellerId, connectionId, organizationFingerprint, accountScopeHash) so its rows can be
  // isolated to exactly this account. Missing/incomplete owner metadata FAILS CLOSED here -- it must NEVER
  // fall through to the legacy full-batch path (which would leak every batch member's rows into this account).
  // Legacy no-owner assembly is allowed ONLY for genuinely single-account plans (no batched seller source).
  const batchedSeller = (planned.sources || []).some((s) => isBatchedSellerFragment(s));
  if (batchedSeller) {
    const missing = missingOwnerFields(planned.owner);
    if (missing.length) {
      return fail("derive", "OWNER_BINDING_MISSING", `A batched seller-scoped report requires complete owner metadata; missing/blank: ${missing.join(", ")}. Refusing to derive (fail closed).`, true);
    }
  }
  // When this report/account is an OWNER of a shared <=5-account BATCH source, its authoritative owner metadata
  // (from corrected 4b) drives per-account row isolation inside assembleSources. A single-account report carries
  // no such owner (planned.owner absent) and takes the byte-identical legacy path.
  const { sources, latestFetchedAt } = assembleSources(planned.sources, statusByHash, loadedByHash, errorByHash, planned.owner || null);

  // Load DERIVE-ONLY injected inputs (persisted non-DataDoe rows, e.g. the scheduled Ads rows for
  // Daily Reporting) through an injected callback. These reach the pure adapter via the derive
  // context but are DELIBERATELY excluded from the snapshot `params` below, so they never enter the
  // snapshot identity/paramsHash. A throwing/absent loader leaves derivedContext empty; a required
  // derived input the adapter needs but does not receive fails inside derive (last-known-good kept).
  let derivedContext = {};
  if (typeof loadDerivedContext === "function") {
    try {
      derivedContext = (await loadDerivedContext({ reportKey, accountId, planned, sources, statusByHash })) || {};
    } catch (_e) {
      derivedContext = {};
    }
  }

  // Deterministic derivation context, built FAIL-CLOSED (Blocker 1): the planned account/brand/
  // date scope is authoritative, derived inputs are restricted to this report's explicit
  // allowlist and can never override the planned scope, and retrievedAt comes from the saved
  // source metadata (the latest fragment fetch time), NEVER Date.now(). derivedContext is
  // derive-only (never a snapshot param -- the snapshot `params` below use planned.context only).
  const context = buildDeriveContext({ entry, plannedContext: planned.context, derivedContext, accountId, latestFetchedAt });

  // 4) Derive (pure). Never fabricate on unavailable/blocked/invalid/not-implemented.
  const result = deriveReportSnapshot({ reportKey, sources, context });
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

  // 5) VALIDATE the derived latest data date BEFORE saving. sync_report_jobs.latest_data_date
  //    is a Postgres `date`; a present-but-impossible value (e.g. 2026-02-30 from bad source
  //    data) must fail at the VALIDATE stage so the shadow snapshot is never saved ahead of a
  //    date write that would then fail. A legitimately absent date (null) is fine. The error is
  //    a safe operator string -- no payload/secret.
  const latestDataDate = toDateOnly(result.latestDataDate);
  if (result.latestDataDate != null && String(result.latestDataDate) !== "" && latestDataDate === null) {
    return fail("validate", "INVALID_LATEST_DATE", "Derived latest data date is not a valid calendar date; snapshot not saved (previous data preserved).", true);
  }

  // 6) SIZE GUARD: reject an oversized shadow payload BEFORE any Supabase write, recomputing the
  //    ACTUAL UTF-8 byte size (never a trusted caller value) against the canonical limit.
  //    Recorded as a save-stage failure; the previous snapshot is preserved and saveSnapshot is
  //    never called (zero writes).
  const payloadBytes = snapshotByteSize(result.payload);
  if (payloadBytes > maxSnapshotBytes) {
    return fail("save", "SNAPSHOT_SAVE_FAILED", `Shadow snapshot ${(payloadBytes / (1024 * 1024)).toFixed(1)} MB exceeds the ${(maxSnapshotBytes / (1024 * 1024))} MB limit; not saved (previous snapshot preserved).`, false);
  }

  // 7) SAVE the shadow snapshot. A save failure is a SEPARATE stage from derive/validate and
  //    never overwrites the previous good snapshot (save throws before any pointer moves). The
  //    saver recomputes bytes again as an impossible-to-bypass final-boundary guard.
  const params = { reportVersion: entry.snapshotVersion, accountId, ...(planned.context || {}) };
  let saved;
  try {
    saved = await saveSnapshot({
      reportKey: shadowSnapshotKey(reportKey),
      accountId,
      params,
      payload: result.payload,
      payloadBytes,
      sourceRefreshedAt: planned.sourceRefreshedAt || context.retrievedAt || null,
    });
  } catch (error) {
    return fail("save", "SNAPSHOT_SAVE_FAILED", "Saving the shadow snapshot failed; previous snapshot preserved.", false);
  }
  const rowCount = Array.isArray(result.payload && result.payload.rows) ? result.payload.rows.length
    : Array.isArray(result.payload && result.payload.events) ? result.payload.events.length : null;

  // 8) SUCCESS: fetch + derive + validate + save all passed. latest_data_date is the strict
  //    YYYY-MM-DD validated above.
  await store.recordReportSuccess({
    cycleId, reportKey, accountId,
    latestDataDate,
    rowCount, payloadBytes,
    snapshotParamsHash: saved && saved.paramsHash ? saved.paramsHash : null,
    durationMs: clock() - started,
  });
  return { reportKey, accountId, status: "succeeded", latestDataDate, rowCount };
}

/**
 * Assemble the cache-only `sources` map from planned source entries, PRESERVING EVERY
 * request-hash fragment (five-ID chunk / month window) with its metadata -- one fragment
 * NEVER overwrites another. PURE + synchronous (rows are pre-loaded into `loadedByHash`).
 *
 * `plannedSources`: [{ requestKey, requestHash, from?, to?, sellerOrVendorIds?, optional?, disabledPolicy? }]
 * `statusByHash`:   { [requestHash]: fetch_status }
 * `errorByHash`:    { [requestHash]: error_code | null }  -- the canonical sync_source_jobs SAFE error_code.
 *                   A fragment is `disabled` (a setup state, not a failure) ONLY on a genuine source-disabled
 *                   DURABLE outcome: fetch_status='failed' AND error_code==='SOURCE_DISABLED' AND the planned
 *                   availability/disabled policy is present. Policy presence ALONE never proves a disable, and
 *                   NO other failure (EXPORT_ERROR / HTTP_5xx / TIMEOUT / TRUNCATED / cache-persist) is ever a
 *                   disable. Error messages / HTTP text are NEVER parsed.
 * `loadedByHash`:   Map/obj requestHash -> { rows, fetched_at? } | null  (from getSourceExportCache)
 *
 * Returns `{ sources, latestFetchedAt }`. For each requestKey:
 *   available   -- true only if >=1 fragment AND every fragment loaded a validated array
 *                  (a miss/malformed fragment => false; NEVER coerced to []).
 *   fragments   -- ordered [{requestHash, requestKey, from, to, sellerOrVendorIds, rows,
 *                  fetchedAt, fragmentIndex, jobStatus, disabled, disabledPolicy}] in the
 *                  CANONICAL RESOLVER/PLAN sequence (fragmentIndex = position in
 *                  plannedSources), which matches the live transport's five-ID chunk /
 *                  window order -- NEVER sorted by request_hash (a SHA is not a sequence
 *                  key). FBA monthly fragments keep their window because grouped rows do not
 *                  carry the month.
 *   rows        -- safe concatenation of all fragment rows in that sequence when available
 *                  (identical to sequential fetchExportRows concatenation), else null.
 */
export function assembleSources(plannedSources, statusByHash, loadedByHash, errorByHash = {}, owner = null) {
  const get = (h) => (loadedByHash instanceof Map ? loadedByHash.get(h) : loadedByHash[h]);
  const errorOf = (h) => (errorByHash instanceof Map ? errorByHash.get(h) : (errorByHash ? errorByHash[h] : null)) || null;
  const byKey = new Map();
  let latestFetchedAt = null;
  (plannedSources || []).forEach((s, fragmentIndex) => {
    if (!byKey.has(s.requestKey)) byKey.set(s.requestKey, []);
    const jobStatus = statusByHash[s.requestHash];
    let rows = null, fetchedAt = null;
    if (jobStatus === "succeeded") {
      const payload = get(s.requestHash);
      if (payload && Array.isArray(payload.rows)) { rows = payload.rows; fetchedAt = payload.fetched_at ?? payload.fetchedAt ?? null; }
    }
    // Blocker 4c: when an OWNER is supplied and THIS fragment is a seller-scoped shared batch, isolate ONLY
    // this owner's rows (matched by its authoritative rawSellerId) into a NEW array -- the shared cached
    // payload is never mutated -- and narrow the fragment scope to exactly [rawSellerId] so downstream
    // single-account validators still fail closed. A Product Catalog (organization-wide) fragment and the
    // legacy no-owner path are byte-identical. A rawSellerId from another org/connection is rejected
    // (rows -> null), leaving the source unavailable rather than attributing cross-org rows.
    let scopeIds = s.sellerOrVendorIds || null;
    if (owner && rows !== null) {
      const iso = isolateFragmentRowsForOwner({ rows, sourceScope: s.sourceScope, sellerOrVendorIds: scopeIds, organizationFingerprint: s.organizationFingerprint, connectionId: s.connectionId }, owner);
      rows = iso.rows;
      scopeIds = iso.sellerOrVendorIds;
    }
    if (fetchedAt && (!latestFetchedAt || String(fetchedAt) > String(latestFetchedAt))) latestFetchedAt = fetchedAt;
    byKey.get(s.requestKey).push({
      // fragmentIndex is the IMMUTABLE canonical sequence key (the resolver/plan emission
      // order == the account/chunk/window fetch order); the request_hash is NEVER a sort key.
      fragmentIndex,
      requestHash: s.requestHash, requestKey: s.requestKey, from: s.from ?? null, to: s.to ?? null,
      sellerOrVendorIds: scopeIds || null, rows, fetchedAt,
      jobStatus: jobStatus || "missing",
      // `disabled` is a source-DISABLED setup state, proven ONLY by the durable outcome: the canonical job
      // failed with the safe error_code SOURCE_DISABLED AND a planned disabled/availability policy exists.
      // A policy alone is not evidence; every OTHER failure (EXPORT_ERROR/HTTP_5xx/TIMEOUT/TRUNCATED/cache-
      // persist) stays non-disabled and derives as typed unavailable (LKG preserved).
      disabled: jobStatus === "failed" && errorOf(s.requestHash) === "SOURCE_DISABLED" && !!s.disabledPolicy,
      errorCode: errorOf(s.requestHash), disabledPolicy: s.disabledPolicy || null,
      optional: !!s.optional,
    });
  });
  const sources = {};
  for (const [requestKey, frags] of byKey) {
    // Preserve canonical plan order (matches sequential fetchExportRows concatenation).
    frags.sort((a, b) => a.fragmentIndex - b.fragmentIndex);
    const allArrays = frags.length > 0 && frags.every((f) => Array.isArray(f.rows));
    sources[requestKey] = {
      available: allArrays,
      rows: allArrays ? frags.flatMap((f) => f.rows) : null,
      fragments: frags,
      disabled: frags.some((f) => f.disabled),
      disabledPolicy: (frags.find((f) => f.disabledPolicy) || {}).disabledPolicy || null,
      reason: allArrays ? null : `source "${requestKey}" has a missing/malformed fragment`,
    };
  }
  return { sources, latestFetchedAt };
}

/**
 * Run (or resume) the report half of ONE cycle for a fixed set of planned report jobs.
 * Idempotent: upserts each report job, derives only ready+unfinished ones, bounded by maxJobs
 * and a wall-clock deadline. Returns progress + per-report outcomes; never a secret.
 */
export async function runReportJobs({
  store, cycleId, sourceRows, saveSnapshot, plannedReports = [],
  clock = () => Date.now(), deadlineMs = Infinity, reserveMs = 3000, maxJobs = Infinity,
  // Canonical shared-snapshot ceiling from the dependency-free limits leaf (no literal that
  // could drift from report-store.js). The worker recomputes actual bytes and checks this.
  maxSnapshotBytes = MAX_SNAPSHOT_BYTES,
  // Optional injected loader for DERIVE-ONLY inputs (persisted non-DataDoe rows, e.g. the
  // scheduled Ads rows Daily Reporting merges). Reaches the pure adapter via the derive context,
  // never the snapshot params. null => reports that need no derived input (brand-sales, sku-pl...).
  loadDerivedContext = null,
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

  // Source dependency statuses for gating + the durable SAFE error_code for source-disabled detection (a
  // policy is never used as evidence of the actual failure cause -- see assembleSources).
  const sourceJobs = await store.listSourceJobs(cycleId);
  const statusByHash = {};
  const errorByHash = {};
  for (const j of sourceJobs) {
    const h = j.request_hash ?? j.requestHash;
    statusByHash[h] = j.fetch_status ?? j.fetchStatus;
    errorByHash[h] = j.error_code ?? j.errorCode ?? null;
  }

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
      outcome = await runOneReport({ store, cycleId, sourceRows, saveSnapshot, planned, statusByHash, errorByHash, clock, maxSnapshotBytes, loadDerivedContext });
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
