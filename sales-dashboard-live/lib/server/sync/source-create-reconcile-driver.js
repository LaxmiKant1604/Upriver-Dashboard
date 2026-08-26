// Scheduler v2 -- PRODUCTION WIRING for the reviewed reconcile-and-adopt operation (source-create-reconcile.js).
//
// One call reconciles ONE bucket's TODAY cycle: re-plans the canonical OLI jobs from the SAME durable evidence
// the engine plans from, lists the real DataDoe exports (a free idempotent GET with bounded retry), adopts an
// exactly-one exact-identity COMPLETED export per eligible failed create-stage job via a precondition-guarded
// conditional UPDATE, then runs the reviewed download-only recovery. ZERO new creates by construction (the
// adapter handed to the recovery has create guarded off). Used by the scheduled OLI runner and the manual
// source-sync operator when a drain stalls on typed create-stage failures -- the structural fix for network
// failure class 4 ("after an ambiguous create, list/reconcile exact exports and adopt only an exact identity").
//
// Returns { ran, attempted, adopted, recovered, results } -- { ran: false, reason } when there is nothing
// eligible (no cycle / no failed create-stage OLI jobs), so callers can gate cheaply.

import pg from "pg";
import { reconcileFailedCreates, reconcileEligibility } from "./source-create-reconcile.js";
import { OLI_SOURCE_KEY } from "./source-durable-model.js";
import { planBucketSourceSync } from "./source-bucket-sync.js";
import { makeSupabaseSourceStore, makeDataDoeAdapter } from "./source-sync-driver.js";
import { sourceContractForKey } from "../source-contracts.js";
import { getDataDoeConnections } from "../datadoe-connections.js";
import { getSyncCycleByBucketDate } from "../supabase.js";
import { withDataDoeDeadline } from "../datadoe.js";

const S = (v) => (v == null ? "" : String(v));

// A free idempotent GET; bounded retry through DataDoe's transient 5xx blips (NEVER a create).
async function listRecentExports({ apiKey, attempts = 5, backoffMs = 8000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const r = await fetch("https://api.datadoe.com/api/v1/exports?pageSize=25", { headers: { "datadoe-api-key": apiKey } });
      if (r.ok) return ((await r.json()).data) || [];
      if (attempt >= attempts) throw new Error("DataDoe exports list failed (" + r.status + ")");
    } catch (e) { if (attempt >= attempts) throw e; }
    await sleep(backoffMs * attempt);
  }
}

// The precondition-guarded durable adoption write: ONLY a failed, non-terminal, create-stage, export-id-NULL row
// for this exact (cycle, request_hash) is flipped into the download-recovery shape. rowCount 1 proves it.
async function adoptExportIdPg({ cycleId, requestHash, exportId }) {
  const client = new pg.Client({ connectionString: String(process.env.POSTGRES_URL).split("?")[0], ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    const r = await client.query(
      "update public.sync_source_jobs set export_id=$3, error_stage='download', error_code='CREATE_RECONCILED', error_message='Adopted the exact-identity completed export after an ambiguous create (reconcile-and-adopt; zero new creates).', updated_at=now() where cycle_id=$1 and request_hash=$2 and fetch_status='failed' and terminal=false and error_stage='create-export' and export_id is null",
      [cycleId, requestHash, exportId],
    );
    return r.rowCount === 1;
  } finally { try { await client.end(); } catch { /* ignore */ } }
}

/**
 * Reconcile ONE bucket's TODAY cycle. `preflight` is the runtime's preflightEvidence result (accounts +
 * membership + the evidence bundle + today/asOf) -- the SAME trusted inputs the engine plans from; `deadline`
 * bounds the store reads; `budgetMs` bounds each recovery poll/download.
 */
export async function runCycleCreateReconcile({ preflight, bucket, deadline = null, budgetMs = 480_000, log = () => {} } = {}) {
  if (!preflight || !Array.isArray(preflight.accounts)) throw new Error("runCycleCreateReconcile requires the runtime preflight (fail closed).");
  if (bucket !== "us" && bucket !== "non-us") throw new Error("runCycleCreateReconcile requires bucket 'us'|'non-us' (fail closed).");
  const today = S(preflight.today);
  const cycle = await getSyncCycleByBucketDate(bucket, today);
  if (!cycle || !cycle.id) return { ran: false, reason: "no-cycle" };

  const store = makeSupabaseSourceStore({ deadline });
  const jobs = await store.listSourceJobsWithMeta(String(cycle.id));
  const eligible = (Array.isArray(jobs) ? jobs : []).filter((j) => reconcileEligibility(j).eligible);
  if (!eligible.length) return { ran: false, reason: "no-eligible-jobs" };
  log("create-reconcile[" + bucket + "]: " + eligible.length + " ambiguous create-stage OLI job(s) -- reconciling against the real exports list (zero new creates)");

  // RE-PLAN so the canonical OLI jobs (and hashes) carry the exact seller identity for still-missing slices.
  const evidenceBundle = preflight.evidence || {};
  const coverageByAccountId = {};
  for (const a of preflight.accounts || []) coverageByAccountId[a.accountId] = [...((evidenceBundle.oliCoverageByAccountId || {})[a.accountId] || [])];
  const plan = planBucketSourceSync({
    apiKey: process.env.DATADOE_API_KEY, bucket, accounts: preflight.accounts || [],
    existingMembership: preflight.membership, coverageByAccountId,
    catalogCarrierSeller: preflight.catalogCarrierSeller || null,
    catalogSnapshot: evidenceBundle.catalogSnapshot || null,
    fbaSnapshotsByAccount: evidenceBundle.fbaSnapshotsByAccount || {},
    asOf: preflight.asOf, today: preflight.today,
  });
  const plannedOliJobs = ((plan.families || []).find((f) => f.sourceKey === OLI_SOURCE_KEY) || {}).plannedJobs || [];

  const connections = getDataDoeConnections();
  const primary = connections.find((c) => c && c.id === "primary");
  if (!primary || !primary.apiKey) throw new Error("runCycleCreateReconcile requires the primary DataDoe connection (fail closed).");
  const deadlineAt = Date.now() + Math.max(30_000, Number(budgetMs) || 0);
  const res = await reconcileFailedCreates({
    cycleId: String(cycle.id), store, dataDoe: makeDataDoeAdapter(connections),
    plannedOliJobs,
    listExports: () => listRecentExports({ apiKey: primary.apiKey }),
    adoptExportId: adoptExportIdPg,
    oliSourceId: sourceContractForKey(OLI_SOURCE_KEY).ids[0],
    runWithDeadline: (fn) => withDataDoeDeadline(deadlineAt, fn), log,
  });
  log("create-reconcile[" + bucket + "]: attempted=" + res.attempted + " adopted=" + res.adopted + " recovered=" + res.recovered);
  return { ran: true, ...res };
}
