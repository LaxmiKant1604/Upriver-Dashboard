// Scheduler v2 Phase 1c — SHADOW-MODE composition driver.
//
// Wires the pure source worker (source-worker.js) to real Supabase + DataDoe I/O and
// runs the STAGED loop: plan primaries -> execute -> derive typed signals from the
// validated results -> re-plan downstream/fallback through the approved Phase 1b
// resolver -> execute, until nothing new is planned or the deadline is reached.
//
// SHADOW MODE: this module is NOT imported by any route, cron, or the Scheduler v1
// worker (run-sync.js). It exists so Phase 1d and the pg_cron/Vercel kickoff can wire
// it later. Nothing here runs a live DataDoe probe on import.

import { createExport, pollExport, downloadExport } from "../datadoe.js";
import {
  openSyncCycle, claimSyncCycle, getSyncCycle, updateSyncCycleCounts,
  upsertSyncSourceJob, getSyncSourceJobs, claimSourceExportAttempt,
  recordSyncSourceSuccess, recordSyncSourceFailure, saveSourceExportCache,
} from "../supabase.js";
import { REPORT_SOURCE_CONTRACTS } from "./report-source-contracts.js";
import { runSourceJobs } from "./source-worker.js";
import { deriveSignalsFromOutcomes } from "./source-signals.js";

const SOURCE_CACHE_TTL_MS = 20 * 3600 * 1000; // matches the shared source-cache horizon

// Turn a resolved job (from reportSourceRequestHashes) into a planned source job that
// carries BOTH the durable identity fields and the in-memory fetch params the live
// fetcher needs. fetchParams is NEVER persisted (the DB stores request_meta only).
export function plannedSourceJob(reportKey, resolved, bucket) {
  const contract = (REPORT_SOURCE_CONTRACTS[reportKey] || []).find((c) => c.requestKey === resolved.requestKey);
  return {
    requestHash: resolved.requestHash,
    requestKey: resolved.requestKey,
    sourceId: resolved.sourceId,
    sourceKey: resolved.sourceKey,
    connectionId: resolved.connectionId || "primary",
    organizationFingerprint: resolved.organizationFingerprint,
    accountScopeHash: resolved.accountScopeHash,
    requestMeta: resolved.requestMeta,
    bucket: resolved.bucket || bucket,
    strict: resolved.strict === true,
    limit: resolved.limit,
    // in-memory only — the params required to re-issue the exact export:
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
  return {
    openCycle: (args) => openSyncCycle(args),
    claimCycle: (cycleId) => claimSyncCycle(cycleId),
    getCycle: (cycleId) => getSyncCycle(cycleId),
    upsertSourceJob: (job) => upsertSyncSourceJob(job),
    listSourceJobs: (cycleId) => getSyncSourceJobs(cycleId),
    claimExportAttempt: (cycleId, requestHash) => claimSourceExportAttempt(cycleId, requestHash),
    saveSourceRows: async ({ job, rows, payloadBytes, exportId }) => {
      const saved = await saveSourceExportCache({
        requestHash: job.request_hash ?? job.requestHash,
        sourceId: job.source_id ?? job.sourceId,
        organizationFingerprint: job.organization_fingerprint ?? job.organizationFingerprint ?? "",
        accountScopeHash: job.account_scope_hash ?? job.accountScopeHash ?? "",
        requestMeta: job.request_meta ?? job.requestMeta ?? {},
        rows,
        payloadBytes,
        expiresAt: new Date(Date.now() + SOURCE_CACHE_TTL_MS).toISOString(),
      });
      // exportId is threaded only so the job row can resume a poll/download.
      void exportId;
      return saved?.object_path || null;
    },
    recordSourceSuccess: (args) => recordSyncSourceSuccess(args),
    recordSourceFailure: (args) => recordSyncSourceFailure(args),
    updateCycleCounts: (cycleId, counts) => updateSyncCycleCounts(cycleId, counts),
  };
}

// Production fetcher: runs ONE DataDoe export for a planned job using the connection's
// apiKey (looked up by connection_id => primary / dd-secondary isolation). The worker
// calls this ONLY after winning claim_source_export_attempt, so it never creates a
// second export. The apiKey is used here and never returned, logged, or stored.
export function makeDataDoeFetcher(connections) {
  const byId = new Map((connections || []).map((c) => [c.id, c]));
  return async function fetchSource(job) {
    const conn = byId.get(job.connection_id ?? job.connectionId) || byId.get("primary");
    if (!conn) throw new Error("No DataDoe connection is configured for this source job's organization.");
    const p = job.fetchParams;
    if (!p || !p.columns) throw new Error("Planned source job is missing its fetch parameters.");
    const created = await createExport(conn.apiKey, job.source_id ?? job.sourceId, p.columns, p.sellerOrVendorIds, p.from, p.to, p.limit, p.options || {});
    const exportId = created.exportId || created.id;
    if (created.status !== "COMPLETED") await pollExport(conn.apiKey, exportId);
    const rows = await downloadExport(conn.apiKey, exportId);
    return { rows, exportId };
  };
}

/**
 * Run (or resume) ONE cycle end to end in staged rounds. `resolvePlan(signals)` returns
 * the flattened planned source jobs for the current typed signals (production wires it
 * to reportSourceRequestHashes over the account set; tests inject a fixture). Downstream
 * jobs appear only once their primary's validated signal has been derived, so a probe
 * failure spends no downstream export and preserves the prior report. Bounded by
 * maxRounds, maxJobs, and the wall-clock deadline; never exposes a secret.
 */
export async function runStagedSourceCycle({
  store, fetchSource, resolvePlan, extraSignals = {},
  bucket, cycleDate, scheduledAt = null, trigger = "manual",
  clock = () => Date.now(), deadlineMs = Infinity, reserveMs = 3_000, maxJobs = Infinity, maxRounds = 5,
}) {
  let signals = { ...extraSignals };
  const rollup = {
    cycleId: null, rounds: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0,
    deadlineReached: false, drained: false, signals,
  };
  const seenHashes = new Set();

  for (let round = 0; round < maxRounds; round += 1) {
    const plan = await resolvePlan(signals);
    const plannedJobs = (plan && plan.sourceJobs) || [];
    const remaining = maxJobs === Infinity ? Infinity : Math.max(0, maxJobs - rollup.processed);
    if (remaining === 0) { rollup.drained = false; break; }

    const res = await runSourceJobs({
      store, fetchSource, plannedJobs, bucket, cycleDate, scheduledAt, trigger,
      clock, deadlineMs, reserveMs, maxJobs: remaining,
    });
    rollup.cycleId = res.cycleId;
    rollup.rounds = round + 1;
    rollup.processed += res.processed;
    rollup.succeeded += res.succeeded;
    rollup.failed += res.failed;
    rollup.skipped += res.skipped;

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
