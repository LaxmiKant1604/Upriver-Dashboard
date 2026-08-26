// Scheduler v2 -- TRUSTED reconcile-and-adopt for AMBIGUOUS OLI create-exports (network behavior rule 4: "after
// an ambiguous create, list/reconcile exact exports and adopt only an exact identity -- never a blind retry").
//
// A create-stage failure (HTTP 503 / CREATE_INTERRUPTED) leaves a typed non-terminal job with NO export id --
// but the create may have LANDED server-side (observed in production: the "failed" batches' exports complete at
// DataDoe). This operation closes that gap with ZERO new creates:
//   1. list the cycle's failed create-stage OLI jobs (typed, non-terminal, export_id null, one attempted create);
//   2. RECONCILE each against the real DataDoe exports list by EXACT identity -- source, date window, and the
//      canonical <=5-seller set from the RE-PLANNED job (the planner re-emits the same canonical hash);
//   3. EXACTLY ONE match -> durably ADOPT its export id onto the job (a precondition-guarded write), flipping it
//      into the reviewed download-recovery shape; zero or multiple matches -> a typed refusal for that job
//      (never a guess, never a fresh create here -- the next day's rolling window recovers a truly lost slice);
//   4. run the reviewed download-only recovery (recoverFailedDownloadJob) per adopted job through a
//      create-GUARDED adapter -- any create-export THROWS, so this operation can never spend a token.

import { recoverFailedDownloadJob } from "./source-worker.js";
import { OLI_SOURCE_KEY } from "./source-durable-model.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const dateOnly = (v) => S(v).slice(0, 10);
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * PURE: match ONE failed create-stage job against the DataDoe exports list by EXACT identity. `sellerIds` is the
 * canonical seller set from the RE-PLANNED job for the same request hash; `windowFrom/To` from the durable
 * request_meta. Returns { disposition: "adopt", exportId } | { disposition: "none" } | { disposition:
 * "ambiguous", matches }. Identity: COMPLETED status, the OLI source (short/long id prefix-equal), date-only
 * window equality, and seller-set equality (order-independent). Anything less exact never adopts.
 */
export function matchExportForFailedCreate({ windowFrom, windowTo, sellerIds, exports, oliSourceId } = {}) {
  const want = new Set((sellerIds || []).map(S).filter(nb));
  const from = dateOnly(windowFrom); const to = dateOnly(windowTo);
  const srcId = S(oliSourceId);
  if (!want.size || !nb(from) || !nb(to) || !nb(srcId)) return { disposition: "none" };
  const sameSource = (recId) => { const a = S(recId); return a === srcId || srcId.startsWith(a) || a.startsWith(srcId); };
  const matches = (Array.isArray(exports) ? exports : []).filter((e) => {
    if (!e || S(e.status) !== "COMPLETED" || !sameSource(e.sourceId)) return false;
    if (dateOnly(e.from) !== from || dateOnly(e.to) !== to) return false;
    const got = new Set((e.sellerOrVendorIds || []).map(S).filter(nb));
    return setEq(want, got);
  });
  if (matches.length === 1) return { disposition: "adopt", exportId: S(matches[0].id) };
  return matches.length === 0 ? { disposition: "none" } : { disposition: "ambiguous", matches: matches.length };
}

// A failed create-stage OLI job eligible for reconciliation: typed, non-terminal, exactly one attempted create,
// and NO saved export id (the ambiguity this operation resolves).
export function reconcileEligibility(jobRow) {
  const status = S(jobRow && (jobRow.fetch_status ?? jobRow.fetchStatus));
  const stage = S(jobRow && (jobRow.error_stage ?? jobRow.errorStage));
  const exportId = jobRow && (jobRow.export_id ?? jobRow.exportId);
  if (S(jobRow && (jobRow.source_key ?? jobRow.sourceKey)) !== OLI_SOURCE_KEY) return { eligible: false, reason: "not-oli" };
  if (status !== "failed") return { eligible: false, reason: "not-failed" };
  if ((jobRow.terminal ?? false) === true) return { eligible: false, reason: "terminal" };
  if (stage !== "create-export") return { eligible: false, reason: "stage-not-create" };
  if (Number(jobRow.create_export_count ?? jobRow.createExportCount ?? 0) !== 1) return { eligible: false, reason: "create-count-not-one" };
  if (exportId != null && S(exportId).trim() !== "") return { eligible: false, reason: "export-id-already-saved" };
  return { eligible: true };
}

/**
 * Reconcile + recover EVERY eligible failed create-stage OLI job of ONE cycle. Injected collaborators:
 *   store            -- listSourceJobsWithMeta(cycleId) + the recovery store (claimSourceExportRecovery, ...);
 *   dataDoe          -- poll/download only (create is GUARDED off);
 *   plannedOliJobs   -- the RE-PLANNED canonical OLI jobs (the planner re-emits the same hashes for still-missing
 *                       slices; the plan carries the canonical seller set + fetch identity the recovery needs);
 *   listExports      -- () -> the recent DataDoe exports (free GET);
 *   adoptExportId    -- ({ cycleId, requestHash, exportId }) -> boolean: the precondition-guarded durable write
 *                       (failed + non-terminal + create-stage + export_id NULL) that flips the job into the
 *                       download-recovery shape; MUST return false when the precondition no longer holds;
 *   runWithDeadline  -- bounds each poll/download.
 * Returns { attempted, adopted, recovered, results } -- typed per-job dispositions, zero creates by construction.
 */
export async function reconcileFailedCreates({ cycleId, store, dataDoe, plannedOliJobs, listExports, adoptExportId, oliSourceId, runWithDeadline = (fn) => fn(), clock = () => Date.now(), log = () => {} } = {}) {
  if (!nb(oliSourceId)) throw new Error("reconcileFailedCreates requires the canonical OLI DataDoe source id (fail closed).");
  if (!nb(cycleId)) throw new Error("reconcileFailedCreates requires a cycleId (fail closed).");
  if (!store || typeof store.listSourceJobsWithMeta !== "function") throw new Error("reconcileFailedCreates requires the recovery store (fail closed).");
  if (typeof adoptExportId !== "function" || typeof listExports !== "function") throw new Error("reconcileFailedCreates requires listExports + adoptExportId (fail closed).");
  const guardedDataDoe = {
    create: async () => { throw new Error("create-reconcile NEVER creates an export (fail closed)."); },
    poll: (...a) => dataDoe.poll(...a),
    download: (...a) => dataDoe.download(...a),
  };
  const planned = Array.isArray(plannedOliJobs) ? plannedOliJobs : [];
  const jobs = await store.listSourceJobsWithMeta(cycleId);
  const eligible = (Array.isArray(jobs) ? jobs : []).filter((j) => reconcileEligibility(j).eligible);
  const results = [];
  let adopted = 0; let recovered = 0;
  const exports = eligible.length ? await listExports() : [];
  for (const row of eligible) {
    const hash = S(row.request_hash ?? row.requestHash);
    const meta = row.request_meta ?? row.requestMeta ?? {};
    const plannedForHash = planned.filter((p) => S(p.requestHash ?? p.request_hash) === hash);
    const p0 = plannedForHash[0];
    const fp0 = (p0 && p0.fetchParams) || {};
    const sellerIds = Array.isArray(fp0.sellerOrVendorIds) ? fp0.sellerOrVendorIds.map(S) : [];
    if (!plannedForHash.length || !sellerIds.length || sellerIds.length > 5) {
      results.push({ requestHash: hash.slice(0, 12), disposition: "no-planned-identity" });
      continue;
    }
    if (dateOnly(fp0.from) !== dateOnly(meta.from) || dateOnly(fp0.to) !== dateOnly(meta.to)) {
      results.push({ requestHash: hash.slice(0, 12), disposition: "planned-window-mismatch" });
      continue;
    }
    const match = matchExportForFailedCreate({ windowFrom: meta.from, windowTo: meta.to, sellerIds, exports, oliSourceId });
    if (match.disposition !== "adopt") {
      results.push({ requestHash: hash.slice(0, 12), disposition: match.disposition });
      continue;
    }
    const wrote = await adoptExportId({ cycleId, requestHash: hash, exportId: match.exportId });
    if (wrote !== true) { results.push({ requestHash: hash.slice(0, 12), disposition: "adopt-write-refused" }); continue; }
    adopted += 1;
    // Re-list to hand the recovery the DURABLE adopted row (the CAS claim binds to the STORED export id).
    const fresh = (await store.listSourceJobsWithMeta(cycleId)).find((j) => S(j.request_hash ?? j.requestHash) === hash);
    const outcome = await recoverFailedDownloadJob({ store, dataDoe: guardedDataDoe, clock, cycleId, meta: p0, jobRow: fresh, runWithDeadline });
    const success = !!(outcome && outcome.status === "success" && outcome.validated === true);
    if (success) recovered += 1;
    results.push({ requestHash: hash.slice(0, 12), disposition: success ? "recovered" : "recovery-" + S(outcome && outcome.status) });
    log("reconcile " + hash.slice(0, 12) + ": adopted -> " + (success ? "recovered" : S(outcome && outcome.status)));
  }
  return { attempted: eligible.length, adopted, recovered, results };
}
