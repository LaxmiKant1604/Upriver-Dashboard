// Scheduler v2 Phase 1c — SHADOW-MODE composition driver.
//
// Wires the pure source worker (source-worker.js) to real Supabase + DataDoe I/O and
// runs the STAGED loop. A brand-new invocation RECONSTRUCTS dependency signals from
// PERSISTED successful source jobs + their saved payloads (and persisted ads rows) — it
// never trusts in-memory-only or browser signals — then plans downstream/fallback jobs
// through the approved Phase 1b resolver.
//
// SHADOW MODE: not imported by any route, cron, or Scheduler v1 (run-sync.js). Nothing
// here runs a live DataDoe probe on import.

import { createExport, pollExport, downloadExport } from "../datadoe.js";
import { organizationFingerprint } from "../source-identity.js";
import {
  openSyncCycle, claimSyncCycle, getSyncCycle, updateSyncCycleCounts,
  upsertSyncSourceJob, getSyncSourceJobs, claimSourceExportAttempt,
  recordSyncSourceSuccess, recordSyncSourceFailure, recordSyncSourceExportCreated,
  getSourceExportCache, sourceCacheStorageAdapter, sourceCacheMetadataAdapter,
} from "../supabase.js";
import { REPORT_SOURCE_CONTRACTS } from "./report-source-contracts.js";
import { runSourceJobs } from "./source-worker.js";
import { atomicSaveSourcePayload } from "./source-cache.js";
import { deriveSignalsFromOutcomes, SIGNAL_PRODUCERS, adsCurrencySignal } from "./source-signals.js";

const SOURCE_CACHE_TTL_MS = 20 * 3600 * 1000;

const VALID_CONNECTION_IDS = new Set(["primary", "dd-secondary"]);

// Turn a resolved job (from reportSourceRequestHashes) into a planned source job that
// carries BOTH the durable identity fields and the in-memory fetch params the live
// adapter needs. fetchParams is NEVER persisted (the DB stores request_meta only).
//
// FAIL CLOSED: connectionId is REQUIRED and explicit ('primary' or 'dd-secondary') — there
// is no silent 'primary' default anywhere in Scheduler v2 — and the resolved job must carry
// a non-empty organizationFingerprint. Both are what the adapter verifies before any call.
export function plannedSourceJob(reportKey, resolved, bucket, connectionId) {
  if (!VALID_CONNECTION_IDS.has(connectionId)) {
    throw new Error(`plannedSourceJob requires an explicit connectionId of 'primary' or 'dd-secondary' (got "${connectionId}").`);
  }
  if (!resolved.organizationFingerprint) {
    throw new Error("plannedSourceJob requires a non-empty organizationFingerprint on the resolved job.");
  }
  const contract = (REPORT_SOURCE_CONTRACTS[reportKey] || []).find((c) => c.requestKey === resolved.requestKey);
  return {
    requestHash: resolved.requestHash,
    requestKey: resolved.requestKey,
    sourceId: resolved.sourceId,
    sourceKey: resolved.sourceKey,
    connectionId,
    organizationFingerprint: resolved.organizationFingerprint,
    accountScopeHash: resolved.accountScopeHash,
    requestMeta: resolved.requestMeta,
    bucket: resolved.bucket || bucket,
    strict: resolved.strict === true,
    limit: resolved.limit,
    fetchParams: {
      columns: contract ? contract.columns : undefined,
      sellerOrVendorIds: resolved.sellerOrVendorIds,
      from: resolved.from,
      to: resolved.to,
      limit: resolved.limit,
      options: resolved.options,
    },
  };
}

// Production store: maps the worker's injected interface to lib/server/supabase.js.
export function makeSupabaseSourceStore() {
  const storage = sourceCacheStorageAdapter();
  const metadata = sourceCacheMetadataAdapter();
  return {
    openCycle: (args) => openSyncCycle(args),
    claimCycle: (cycleId) => claimSyncCycle(cycleId),
    getCycle: (cycleId) => getSyncCycle(cycleId),
    upsertSourceJob: (job) => upsertSyncSourceJob(job),
    listSourceJobs: (cycleId) => getSyncSourceJobs(cycleId),
    claimExportAttempt: (cycleId, requestHash) => claimSourceExportAttempt(cycleId, requestHash),
    recordExportCreated: (args) => recordSyncSourceExportCreated(args),
    loadSourceRows: (requestHash) => getSourceExportCache(requestHash),
    saveSourceRows: ({ job, rows, payloadBytes, version }) => atomicSaveSourcePayload({
      storage, metadata,
      requestHash: job.request_hash ?? job.requestHash,
      sourceId: job.source_id ?? job.sourceId,
      organizationFingerprint: job.organization_fingerprint ?? job.organizationFingerprint ?? "",
      accountScopeHash: job.account_scope_hash ?? job.accountScopeHash ?? "",
      requestMeta: job.request_meta ?? job.requestMeta ?? {},
      rows, payloadBytes,
      expiresAt: new Date(Date.now() + SOURCE_CACHE_TTL_MS).toISOString(),
      version,
    }),
    recordSourceSuccess: (args) => recordSyncSourceSuccess(args),
    recordSourceFailure: (args) => recordSyncSourceFailure(args),
    updateCycleCounts: (cycleId, counts) => updateSyncCycleCounts(cycleId, counts),
  };
}

// Production DataDoe adapter with FAIL-CLOSED organization routing. A source job may run
// ONLY on the connection that owns it: connection_id must be an explicit, valid id, and
// the job's organizationFingerprint must match that connection's key. Missing / unknown /
// mismatched routing throws BEFORE any DataDoe call — an unresolved secondary job is never
// silently sent to the primary key. The apiKey is used here and never returned or stored.
export function makeDataDoeAdapter(connections) {
  const byId = new Map((connections || []).map((c) => [c.id, c]));
  function resolveConnection(job) {
    const id = job.connection_id ?? job.connectionId;
    if (id !== "primary" && id !== "dd-secondary") {
      throw new Error(`Source job has a missing/invalid connection id "${id}".`);
    }
    const conn = byId.get(id);
    if (!conn || !conn.apiKey) throw new Error(`No configured DataDoe connection for "${id}".`);
    const expected = conn.organizationFingerprint || organizationFingerprint(conn.apiKey);
    const jobFingerprint = job.organizationFingerprint ?? job.organization_fingerprint;
    // Unconditional: a missing fingerprint is a hard failure, and it must match the
    // selected connection. A secondary job can never be routed to the primary key.
    if (!jobFingerprint) {
      throw new Error(`Source job for connection "${id}" is missing its organization fingerprint.`);
    }
    if (jobFingerprint !== expected) {
      throw new Error(`Source job organization does not match connection "${id}"; refusing to route it.`);
    }
    return conn;
  }
  return {
    create: async (job) => {
      const conn = resolveConnection(job); // throws before createExport
      const p = job.fetchParams;
      if (!p || !p.columns) throw new Error("Planned source job is missing its fetch parameters.");
      const created = await createExport(conn.apiKey, job.sourceId ?? job.source_id, p.columns, p.sellerOrVendorIds, p.from, p.to, p.limit, p.options || {});
      return { exportId: created.exportId || created.id, completed: created.status === "COMPLETED" };
    },
    poll: async (job, exportId) => { const conn = resolveConnection(job); await pollExport(conn.apiKey, exportId); },
    download: async (job, exportId) => { const conn = resolveConnection(job); return downloadExport(conn.apiKey, exportId); },
  };
}

/**
 * Reconstruct the typed signals a brand-new worker process needs from PERSISTED state:
 * the kickoff plan gives the signal-producing request keys -> hashes; for each whose DB
 * job SUCCEEDED, the saved payload is loaded and the signal re-derived. A failed /
 * terminal / not-yet-successful primary contributes no activating signal. PPC ads currency
 * comes from persisted ads rows (never a live export). No browser/UI input is trusted.
 */
export async function reconstructSignals({ store, cycleId, resolvePlan, adsRowsProvider }) {
  const signals = {};
  const kickoff = await resolvePlan({});
  const producers = (kickoff.sourceJobs || []).filter((j) => SIGNAL_PRODUCERS[j.requestKey]);
  const jobs = await store.listSourceJobs(cycleId);
  const byHash = new Map(jobs.map((j) => [j.request_hash ?? j.requestHash, j]));
  for (const p of producers) {
    const jobRow = byHash.get(p.requestHash);
    const status = jobRow && (jobRow.fetch_status ?? jobRow.fetchStatus);
    if (status !== "succeeded") continue; // only a validated saved success can activate downstream

    // Distinguish a genuine empty success from missing/corrupt cached data. ONLY a payload
    // that LOADS cleanly with an array `rows` (possibly []) is a validated success. A cache
    // miss, a read error, or a payload whose `rows` is not an array is UNAVAILABLE — it must
    // NOT be reconstructed as validated:true, or a missing SQP payload could wrongly activate
    // catalog / monthly-fallback work.
    let rows = null;
    try {
      const payload = store.loadSourceRows ? await store.loadSourceRows(p.requestHash) : null;
      if (payload && Array.isArray(payload.rows)) rows = payload.rows;
    } catch (_readError) {
      rows = null;
    }
    if (rows === null) {
      // Persisted job says succeeded, but its cached payload is missing/unreadable/malformed:
      // a safe source-cache-unavailable state that activates NOTHING downstream.
      signals[p.requestKey] = SIGNAL_PRODUCERS[p.requestKey]({ requestKey: p.requestKey, status: "failed", validated: false, unavailableReason: "source-cache-unavailable" });
      continue;
    }
    signals[p.requestKey] = SIGNAL_PRODUCERS[p.requestKey]({ requestKey: p.requestKey, status: "success", validated: true, rows });
  }
  if (adsRowsProvider) {
    // A validated currency read requires a real array of persisted ads rows. A missing/failed
    // read must NOT present as currencyCount 0 (which would schedule total-sales); it is
    // unavailable, so total-sales stays unscheduled (fail closed).
    let adsRows = null;
    try { adsRows = await adsRowsProvider(); } catch (_e) { adsRows = null; }
    signals["ppc-performance:ads-currency"] = Array.isArray(adsRows)
      ? adsCurrencySignal(adsRows)
      : { status: "failed", validated: false, currencyCount: null };
  }
  return signals;
}

/**
 * Run (or resume) ONE cycle end to end in staged rounds. Reconstructs signals from
 * persisted state first (so a fresh invocation plans downstream without repeating a
 * primary export), then: plan -> execute -> derive fresh signals -> re-plan -> execute,
 * bounded by maxRounds, maxJobs, and the wall-clock deadline. Never exposes a secret.
 */
export async function runStagedSourceCycle({
  store, dataDoe, resolvePlan, adsRowsProvider, extraSignals = {},
  bucket, cycleDate, scheduledAt = null, trigger = "manual",
  clock = () => Date.now(), deadlineMs = Infinity, reserveMs = 3_000, maxJobs = Infinity, maxRounds = 5,
}) {
  const cycleId = await store.openCycle({ bucket, cycleDate, scheduledAt, trigger });
  let signals = { ...(await reconstructSignals({ store, cycleId, resolvePlan, adsRowsProvider })), ...extraSignals };

  const rollup = {
    cycleId, rounds: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0,
    deadlineReached: false, drained: false, signals,
  };
  const seenHashes = new Set();

  for (let round = 0; round < maxRounds; round += 1) {
    const plan = await resolvePlan(signals);
    const plannedJobs = (plan && plan.sourceJobs) || [];
    const remaining = maxJobs === Infinity ? Infinity : Math.max(0, maxJobs - rollup.processed);
    if (remaining === 0) { rollup.drained = false; break; }

    const res = await runSourceJobs({
      store, dataDoe, plannedJobs, bucket, cycleDate, scheduledAt, trigger,
      clock, deadlineMs, reserveMs, maxJobs: remaining,
    });
    rollup.cycleId = res.cycleId;
    rollup.rounds = round + 1;
    rollup.processed += res.processed;
    rollup.succeeded += res.succeeded;
    rollup.failed += res.failed;
    rollup.skipped += res.skipped;
    rollup.counts = res.counts;

    const before = JSON.stringify(signals);
    signals = { ...signals, ...deriveSignalsFromOutcomes(res.outcomes) };
    rollup.signals = signals;

    if (res.deadlineReached) { rollup.deadlineReached = true; rollup.drained = false; break; }

    const planHashes = plannedJobs.map((j) => j.requestHash);
    const allSeen = planHashes.every((h) => seenHashes.has(h));
    planHashes.forEach((h) => seenHashes.add(h));
    if (allSeen && JSON.stringify(signals) === before) { rollup.drained = res.drained; break; }
    rollup.drained = res.drained;
  }
  return rollup;
}
