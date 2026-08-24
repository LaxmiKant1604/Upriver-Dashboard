// TRUSTED, DEFERRED one-shot cleanup of the SINGLE failed priority (v1) Catalog cycle, so a same-date v2 cycle
// can open cleanly. Usage (run from sales-dashboard-live/, AFTER a read-only reconciliation confirms the exact
// footprint):
//   node scripts/release/cleanup-failed-priority-cycle.mjs            -> DRY RUN (read-only PRE assessment; NO writes)
//   node scripts/release/cleanup-failed-priority-cycle.mjs --apply    -> delete ONLY that cycle's exact footprint
//
// The cycle identity is EXACT + fixed (env PRIORITY_CLEANUP_CYCLE_ID, validated as a full UUID). The guarded
// transaction (source-failed-cycle-cleanup.js) re-proves the exact benign footprint UNDER an advisory lock
// before deleting, deletes ONLY this cycle's owners/source-jobs/budgets/(empty)report-jobs/cycle row, NEVER the
// durable Catalog reservation / any snapshot / OLI history / controls / any unrelated cycle, POST-asserts the
// footprint is gone, and COMMITs once. A lost commit ack is typed COMMIT_UNKNOWN (exit 3; no retry/rollback).

import pg from "pg";
import { loadReleaseEnv } from "./env-bootstrap.mjs";
import { runFailedCycleCleanupTransaction, assessFailedCatalogCycle } from "../../lib/server/sync/source-failed-cycle-cleanup.js";

loadReleaseEnv(); // portable: loads <repoRoot>/.env.local when present, maps SUPABASE_URL, never overrides CI env

const MODE = process.argv.includes("--apply") ? "apply" : "dry-run";
const ORG = "__organization";
const ADV = [20260825, 3]; // a dedicated advisory-lock pair for the failed-cycle cleanup
// EXACT, fixed cycle identity (a full UUID). Set PRIORITY_CLEANUP_CYCLE_ID to the reviewed failed v1 US cycle id.
const CYCLE_ID = String(process.env.PRIORITY_CLEANUP_CYCLE_ID || "").trim();
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
if (!UUID.test(CYCLE_ID)) { console.error("STOP set PRIORITY_CLEANUP_CYCLE_ID to the EXACT failed v1 cycle UUID (got: " + (CYCLE_ID || "<empty>") + ")"); process.exit(2); }

console.log("CLEANUP-FAILED-CYCLE mode=" + MODE + " cycle=" + CYCLE_ID.slice(0, 8) + "...");

const base = String(process.env.POSTGRES_URL).split("?")[0];
const client = new pg.Client({ connectionString: base, ssl: { rejectUnauthorized: false } });
const q = (t, p) => client.query(t, p);
await client.connect();

const read = async (cycleId) => {
  const cyc = (await q("select id, bucket, status, trigger from public.sync_cycles where id=$1", [cycleId])).rows[0] || null;
  const sourceJobs = (await q("select source_key, fetch_status, terminal, export_id, error_stage, create_export_count from public.sync_source_jobs where cycle_id=$1", [cycleId])).rows;
  const owners = (await q("select request_hash, account_id from public.sync_source_job_owners where cycle_id=$1", [cycleId])).rows;
  const reportJobs = (await q("select report_key, validated, derive_status from public.sync_report_jobs where cycle_id=$1", [cycleId])).rows;
  const budgets = (await q("select tranche_key, spent_creates, spent_tokens from public.source_tranche_budget where cycle_id=$1", [cycleId])).rows;
  return { cycle: cyc, sourceJobs, owners, reportJobs, budgets, snapshotCount: reportJobs.length === 0 ? 0 : reportJobs.length };
};

const store = {
  read,
  begin: async () => { await q("begin"); await q("select pg_advisory_xact_lock($1::int, $2::int)", ADV); },
  commit: async () => { await q("commit"); },
  rollback: async () => { await q("rollback"); },
  // Delete ONLY this cycle's exact footprint, FK-safe (budget-hash -> budget; job children -> cycle). NEVER the
  // durable Catalog reservation (source_priority_catalog_reservation), any snapshot, OLI history, or controls.
  deleteFootprint: async (cycleId) => {
    await q("delete from public.source_tranche_budget_hash where cycle_id=$1", [cycleId]);
    await q("delete from public.source_tranche_budget where cycle_id=$1", [cycleId]);
    await q("delete from public.sync_source_job_owners where cycle_id=$1", [cycleId]);
    await q("delete from public.sync_source_jobs where cycle_id=$1", [cycleId]);
    await q("delete from public.sync_report_jobs where cycle_id=$1", [cycleId]);
    await q("delete from public.sync_cycles where id=$1", [cycleId]);
  },
};

let result = { committed: false, code: 1 };
try {
  if (MODE === "dry-run") {
    const snap = await read(CYCLE_ID);
    const problems = assessFailedCatalogCycle(CYCLE_ID, snap, { organizationScopeKey: ORG });
    if (problems.length) { console.error("DRY RUN: NOT a clean failed-Catalog footprint -> refusing. problems: " + problems.join("; ")); result = { code: 1 }; }
    else { console.log("DRY RUN: EXACT benign failed-Catalog footprint confirmed (1 failed product-catalog job, no export, no report job, org owner). Re-run with --apply to delete it."); result = { code: 0, dryRun: true }; }
  } else {
    result = await runFailedCycleCleanupTransaction({ store, cycleId: CYCLE_ID, mode: "apply", organizationScopeKey: ORG });
    if (result.committed) console.log("COMMITTED cleanup of failed cycle " + CYCLE_ID.slice(0, 8) + "...");
    else if (result.commitUnknown) { console.error("COMMIT_UNKNOWN: " + result.problem); console.error(result.instruction); }
    else console.error("REFUSED / ROLLED BACK: " + (result.problem || (result.problems || []).join("; ")) + (result.rollbackError ? " [rollback ALSO failed: " + result.rollbackError + "]" : ""));
  }
} catch (e) {
  try { await q("rollback"); } catch { /* ignore */ }
  console.error("cleanup failed before/around the transaction: " + (e && e.message));
  result = { code: 1 };
} finally {
  try { await client.end(); } catch { /* ignore */ }
}
process.exit(result.committed || result.dryRun ? 0 : (result.code === 3 ? 3 : 1));
