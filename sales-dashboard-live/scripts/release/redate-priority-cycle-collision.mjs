// TRUSTED, DEFERRED one-shot re-date of the SINGLE historical Non-US cycle whose anomalous cycle_date collides
// with the priority go-live's Non-US slot. cycle_date is a PostgreSQL DATE, compared/serialized as a
// 'YYYY-MM-DD' string (cycle_date::text) -- NEVER through new Date().toISOString(). Usage (run from
// sales-dashboard-live/):
//   node scripts/release/redate-priority-cycle-collision.mjs           -> DRY RUN (READ ONLY; exact evidence; ROLLBACK)
//   node scripts/release/redate-priority-cycle-collision.mjs --apply   -> one advisory-locked guarded UPDATE + COMMIT
//
// It moves ONLY sync_cycles.cycle_date for the frozen cycle id, from DATE '2026-08-24' to DATE '2026-08-16',
// after proving the EXACT PRE footprint, and verifies the EXACT POST state (only cycle_date + the sync_cycles
// digest change; the other seven protected digests are byte-identical). Exit: 0 committed/dry-run; 1 refused/
// rolled back; 3 COMMIT_UNKNOWN (no rollback/retry).

import pg from "pg";
import { loadReleaseEnv } from "./env-bootstrap.mjs";
import { runRedateCollisionTransaction, assessRedatePre, REDATE } from "../../lib/server/sync/source-redate-cycle-collision.js";
import { captureProtectedDigest } from "./release-state.mjs";

loadReleaseEnv(); // portable: loads <repoRoot>/.env.local when present, maps SUPABASE_URL, never overrides CI env

const MODE = process.argv.includes("--apply") ? "apply" : "dry-run";
const ADV = [20260825, 4];
const CID = REDATE.cycleId;

const base = String(process.env.POSTGRES_URL).split("?")[0];
const client = new pg.Client({ connectionString: base, ssl: { rejectUnauthorized: false } });
const q = (t, p) => client.query(t, p);
await client.connect();

const hasCron = async () => {
  const t = await q("select to_regclass('cron.job')::text cron_table");
  if (!t.rows[0].cron_table) return false;
  const n = await q("select count(*)::int n from cron.job where command ilike '%scheduler%' or command ilike '%sync%' or command ilike '%priority%'");
  return n.rows[0].n > 0;
};

const readEvidence = async () => {
  const cy = (await q("select id::text id, bucket, cycle_date::text cdt, status, trigger, (finished_at is not null) fin, to_char(created_at at time zone 'UTC','YYYY-MM-DD') cud, source_total, source_succeeded, source_failed, report_total, report_succeeded, report_failed from public.sync_cycles where id=$1::uuid", [CID])).rows[0] || null;
  const cycle = cy ? {
    id: cy.id, bucket: cy.bucket, cycleDateText: cy.cdt, status: cy.status, trigger: cy.trigger,
    finishedAtNonNull: cy.fin === true, createdUtcDate: cy.cud,
    counters: { sourceTotal: Number(cy.source_total), sourceSucceeded: Number(cy.source_succeeded), sourceFailed: Number(cy.source_failed), reportTotal: Number(cy.report_total), reportSucceeded: Number(cy.report_succeeded), reportFailed: Number(cy.report_failed) },
  } : null;
  const one = async (sql, p) => Number((await q(sql, p)).rows[0].n);
  const counts = {
    sourceJobs: await one("select count(*)::int n from public.sync_source_jobs where cycle_id=$1::uuid", [CID]),
    owners: await one("select count(*)::int n from public.sync_source_job_owners where cycle_id=$1::uuid", [CID]),
    reportJobs: await one("select count(*)::int n from public.sync_report_jobs where cycle_id=$1::uuid", [CID]),
    validatedReportJobs: await one("select count(*)::int n from public.sync_report_jobs where cycle_id=$1::uuid and validated=true", [CID]),
  };
  const v2LineageCount = await one("select count(*)::int n from public.sync_source_jobs where cycle_id=$1::uuid and request_hash = (select catalog_request_hash from public.source_priority_catalog_reservation where operation_key='priority-dashboards/v2')", [CID]);
  const targetSlotCount = await one("select count(*)::int n from public.sync_cycles where bucket='non-us' and cycle_date = $2::date and id <> $1::uuid", [CID, REDATE.targetDate]);
  const nonUsAtCurrentCount = await one("select count(*)::int n from public.sync_cycles where bucket='non-us' and cycle_date = $1::date", [REDATE.currentDate]);
  const controls = {
    allPrimary: (await q("select all_primary from public.scheduler_rollout_mode where id=1")).rows[0]?.all_primary,
    cron: await hasCron(),
    enabledRollout: await one("select count(*)::int n from public.scheduler_account_rollout where enabled=true"),
    enabledDispatch: await one("select count(*)::int n from public.report_sync_settings where schedule_enabled=true"),
    enabledPromoted: await one("select count(*)::int n from public.source_promoted_publish_settings where publish_enabled=true"),
    approvedCount: await one("select count(*)::int n from public.scheduler_publish_approvals where approved=true"),
  };
  const resv = (await q("select operation_key, status, tokens_spent, (export_id is not null) hase from public.source_priority_catalog_reservation")).rows;
  const rmap = (op) => { const r = resv.find((x) => x.operation_key === op); return r ? { status: r.status, tokens: Number(r.tokens_spent), hasExport: r.hase === true } : null; };
  const reservations = { v1: rmap("priority-dashboards/v1"), v2: rmap("priority-dashboards/v2") };
  const digests = await captureProtectedDigest(q);
  return { cycle, counts, v2LineageCount, targetSlotCount, nonUsAtCurrentCount, controls, reservations, digests };
};

const store = {
  readEvidence,
  begin: async () => { await q("begin"); await q("select pg_advisory_xact_lock($1::int, $2::int)", ADV); },
  commit: async () => { await q("commit"); },
  rollback: async () => { await q("rollback"); },
  update: async () => {
    // The ONLY write: move ONLY cycle_date, guarded by the exact frozen (id, bucket, current DATE, status).
    const r = await q("update public.sync_cycles set cycle_date = $2::date where id = $1::uuid and bucket = 'non-us' and cycle_date = $3::date and status = 'partial'", [CID, REDATE.targetDate, REDATE.currentDate]);
    return r.rowCount;
  },
};

function printEvidence(ev) {
  if (!ev.cycle) { console.log("  cycle NOT FOUND"); return; }
  console.log(`  cycle id=${ev.cycle.id.slice(0, 8)} bucket=${ev.cycle.bucket} cycle_date=${ev.cycle.cycleDateText} status=${ev.cycle.status} trigger=${ev.cycle.trigger} finished=${ev.cycle.finishedAtNonNull} created_utc=${ev.cycle.createdUtcDate}`);
  console.log(`  counts source=${ev.counts.sourceJobs} owners=${ev.counts.owners} reportJobs=${ev.counts.reportJobs} validated=${ev.counts.validatedReportJobs} v2Lineage=${ev.v2LineageCount}`);
  console.log(`  slots: nonUsAtCurrent(${REDATE.currentDate})=${ev.nonUsAtCurrentCount} targetOccupied(${REDATE.targetDate})=${ev.targetSlotCount}`);
  console.log(`  controls all_primary=${ev.controls.allPrimary} cron=${ev.controls.cron} rollout=${ev.controls.enabledRollout} dispatch=${ev.controls.enabledDispatch} promoted=${ev.controls.enabledPromoted} approvals=${ev.controls.approvedCount}`);
  console.log(`  reservations v1=${JSON.stringify(ev.reservations.v1)} v2=${JSON.stringify(ev.reservations.v2)}`);
  console.log(`  digests sync_cycles=${ev.digests.sync_cycles.c}/${ev.digests.sync_cycles.h}`);
}

let result = { committed: false, code: 1 };
try {
  console.log("REDATE-CYCLE-COLLISION mode=" + MODE + " cycle=" + CID.slice(0, 8) + " " + REDATE.currentDate + " -> " + REDATE.targetDate);
  if (MODE === "dry-run") {
    await q("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const ev = await readEvidence();
      printEvidence(ev);
      const problems = assessRedatePre(ev);
      result = await runRedateCollisionTransaction({ store: { ...store, readEvidence: async () => ev }, mode: "dry-run" });
      if (problems.length) console.error("DRY RUN: NOT the exact expected collision -> refusing. problems: " + problems.join("; "));
      else console.log("DRY RUN: EXACT expected collision confirmed. Re-run with --apply to move ONLY cycle_date " + REDATE.currentDate + " -> " + REDATE.targetDate + ".");
    } finally { try { await q("ROLLBACK"); } catch { /* ignore */ } }
  } else {
    result = await runRedateCollisionTransaction({ store, mode: "apply" });
    if (result.committed) console.log("COMMITTED re-date; new sync_cycles digest = " + result.syncCyclesDigest.c + "/" + result.syncCyclesDigest.h);
    else if (result.commitUnknown) { console.error("COMMIT_UNKNOWN: " + result.problem); console.error(result.instruction); }
    else console.error("REFUSED / ROLLED BACK: " + (result.problem || (result.problems || []).join("; ")) + (result.rollbackError ? " [rollback ALSO failed: " + result.rollbackError + "]" : ""));
  }
} catch (e) {
  try { await q("rollback"); } catch { /* ignore */ }
  console.error("re-date failed before/around the transaction: " + (e && e.message));
  result = { code: 1 };
} finally {
  try { await client.end(); } catch { /* ignore */ }
}
process.exit(result.committed || result.dryRun ? 0 : (result.code === 3 ? 3 : 1));
