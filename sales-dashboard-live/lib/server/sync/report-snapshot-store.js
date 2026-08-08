// Scheduler v2 Phase 1d -- production wiring for the report-derivation worker (SHADOW MODE).
//
// Wires the pure report worker (report-worker.js) to real Supabase I/O:
//   - the report-job store (sync_report_jobs) + source-job status reads,
//   - a CACHE-ONLY source-row loader (getSourceExportCache -- never a DataDoe export),
//   - a SHADOW snapshot saver (writes report_snapshots under a namespaced shadow report_key,
//     so a v2 snapshot can never overwrite the production row),
//   - a parity helper comparing a saved shadow snapshot to the saved production snapshot with
//     NO re-fetch.
// This module performs I/O, so (unlike a derivation adapter) it may import supabase.js. It
// still never imports a DataDoe export function.

import {
  getSyncSourceJobs,
  getSyncReportJobs,
  upsertSyncReportJob,
  claimReportDeriveAttempt,
  recordSyncReportBlocked,
  recordSyncReportFailure,
  recordSyncReportSuccess,
  getSourceExportCache,
  saveReportSnapshot,
  getReportSnapshot,
  getLatestReportSnapshot,
} from "../supabase.js";
import { paramsHashFor } from "../report-store.js";
import { MAX_SNAPSHOT_BYTES, assertSnapshotWithinLimit } from "../report-limits.js";
import { shadowSnapshotKey, productionKeyFromShadow, compareReportPayloads } from "./report-derivation.js";

// Re-export the canonical shared-snapshot ceiling (from the dependency-free limits leaf).
export { MAX_SNAPSHOT_BYTES };

// The report-worker `store` interface, backed by Supabase.
export function makeSupabaseReportStore() {
  return {
    listSourceJobs: (cycleId) => getSyncSourceJobs(cycleId),
    upsertReportJob: (job) => upsertSyncReportJob(job),
    listReportJobs: (cycleId) => getSyncReportJobs(cycleId),
    claimReportDerive: (cycleId, reportKey, accountId) => claimReportDeriveAttempt(cycleId, reportKey, accountId),
    recordReportBlocked: (args) => recordSyncReportBlocked(args),
    recordReportFailure: (args) => recordSyncReportFailure(args),
    recordReportSuccess: (args) => recordSyncReportSuccess(args),
  };
}

// CACHE-ONLY source-row loader: reads already-saved canonical rows by request_hash. Returns
// { ...meta, rows } or null; NEVER creates/polls/downloads a DataDoe export.
export function makeSourceRowLoader() {
  return (requestHash) => getSourceExportCache(requestHash);
}

// Shadow snapshot saver injected into the worker. `reportKey` is ALREADY the shadow key
// (the worker calls shadowSnapshotKey). Computes the params hash and upserts through the
// existing report_snapshots path; returns { paramsHash } so the job can record it.
export function makeShadowSnapshotSaver({ save = saveReportSnapshot } = {}) {
  return async ({ reportKey, accountId, params, payload, payloadBytes, sourceRefreshedAt }) => {
    // Impossible-to-bypass guard at the final storage boundary: ALWAYS recompute the actual
    // UTF-8 byte size from JSON.stringify(payload) and validate against THAT. A caller-supplied
    // payloadBytes is NEVER trusted for the check (it may be stale/forged); it is telemetry
    // only. An oversized payload throws (SNAPSHOT_TOO_LARGE) BEFORE any Supabase write.
    const actualBytes = assertSnapshotWithinLimit(payload);
    const paramsHash = paramsHashFor(params.reportVersion, params);
    await save({ reportKey, accountId, paramsHash, params, payload, payloadBytes: actualBytes, sourceRefreshedAt });
    return { paramsHash };
  };
}

/**
 * Parity WITHOUT re-fetch: load the saved v2 shadow snapshot for (productionReportKey,
 * accountId, params) and the current PRODUCTION snapshot, then structurally compare them.
 * `params` must be the same params (incl. reportVersion) the worker saved under.
 */
export async function compareShadowToProduction({ productionReportKey, accountId, params, productionParamsHash }) {
  const shadowKey = shadowSnapshotKey(productionReportKey);
  const shadowHash = paramsHashFor(params.reportVersion, params);
  const shadow = await getReportSnapshot({ reportKey: shadowKey, accountId, paramsHash: shadowHash });
  const production = productionParamsHash
    ? await getReportSnapshot({ reportKey: productionReportKey, accountId, paramsHash: productionParamsHash })
    : await getLatestReportSnapshot({ reportKey: productionReportKey, accountId });
  return {
    shadowReportKey: shadowKey,
    productionReportKey,
    accountId,
    shadowPresent: !!shadow,
    productionPresent: !!production,
    comparison: compareReportPayloads(shadow ? shadow.payload : null, production ? production.payload : null),
  };
}

export { productionKeyFromShadow };
