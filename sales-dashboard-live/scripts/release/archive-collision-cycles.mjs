// TRUSTED, DEFERRED fixed-identity archival of the SIX future-dated Non-US collision cycles (2026-08-25 ..
// 2026-08-30) to frozen unoccupied January-2026 dates. cycle_date is a PostgreSQL DATE, compared/serialized as a
// 'YYYY-MM-DD' string (cycle_date::text) -- NEVER through new Date().toISOString(). Usage (run from
// sales-dashboard-live/):
//   node scripts/release/archive-collision-cycles.mjs          -> DRY RUN (READ ONLY; exact evidence; ROLLBACK)
//   node scripts/release/archive-collision-cycles.mjs --apply  -> one advisory-locked transaction of 6 guarded UPDATEs + COMMIT
//
// It moves ONLY sync_cycles.cycle_date for the 6 frozen ids, after proving each EXACT PRE footprint, then verifies
// the EXACT POST (each cycle at its target; original slots free; child rows byte-identical; every protected table
// -- snapshots, controls, OLI history, Ads history -- byte-identical; sync_cycles row count unchanged). Exit: 0
// committed/dry-run; 1 refused/rolled back; 3 COMMIT_UNKNOWN (no rollback/retry). Prints prefixes/dates only.

import pg from "pg";
import { loadReleaseEnv } from "./env-bootstrap.mjs";
import { runArchiveTransaction, assessArchivePre, ARCHIVE_CYCLES, PROTECTED_TABLES } from "../../lib/server/sync/source-archive-collision-cycles.js";

loadReleaseEnv();

const MODE = process.argv.includes("--apply") ? "apply" : "dry-run";
const ADV = [20260831, 6]; // a dedicated advisory-lock pair for the archival

const base = String(process.env.POSTGRES_URL).split("?")[0];
const client = new pg.Client({ connectionString: base, ssl: { rejectUnauthorized: false } });
const q = (t, p) => client.query(t, p);
await client.connect();

const one = async (sql, p) => Number((await q(sql, p)).rows[0].n);
const hasCron = async () => {
  const t = await q("select to_regclass('cron.job')::text cron_table");
  if (!t.rows[0].cron_table) return false;
  return (await one("select count(*)::int n from cron.job where command ilike '%scheduler%' or command ilike '%sync%' or command ilike '%priority%'"));
};

// Huge durable-history tables get a count-only digest (the single sync_cycles UPDATE structurally cannot touch
// them; a count proves no row added/removed). report_snapshots is hashed on its IDENTITY columns (never the
// payload). Every other protected table is fully content-hashed (all are small).
const HUGE = new Set(["source_oli_daily_history", "ads_daily_source_rows"]);
const captureDigests = async () => {
  const out = {};
  for (const t of PROTECTED_TABLES) {
    const c = await one("select count(*)::int n from public." + t);
    let h = "count-only";
    if (!HUGE.has(t)) {
      if (t === "report_snapshots") {
        h = (await q("select md5(coalesce(string_agg(x.k, '' order by x.k), '')) h from (select (id::text||'|'||report_key||'|'||account_id||'|'||params_hash||'|'||coalesce(source_refreshed_at::text,'')||'|'||coalesce(updated_at::text,'')) k from public.report_snapshots) x")).rows[0].h;
      } else {
        h = (await q("select md5(coalesce(string_agg(t.j, '' order by t.j), '')) h from (select row_to_json(x)::text j from public." + t + " x) t")).rows[0].h;
      }
    }
    out[t] = { c, h };
  }
  return out;
};

const readEvidence = async () => {
  const cyclesById = {};
  for (const a of ARCHIVE_CYCLES) {
    const cy = (await q("select id::text id, bucket, cycle_date::text cdt, status, trigger from public.sync_cycles where id=$1::uuid", [a.cycleId])).rows[0];
    if (!cy) continue;
    cyclesById[a.cycleId] = {
      id: cy.id, bucket: cy.bucket, cycleDateText: cy.cdt, status: cy.status, trigger: cy.trigger,
      counts: {
        sourceJobs: await one("select count(*)::int n from public.sync_source_jobs where cycle_id=$1::uuid", [a.cycleId]),
        owners: await one("select count(*)::int n from public.sync_source_job_owners where cycle_id=$1::uuid", [a.cycleId]),
        reportJobs: await one("select count(*)::int n from public.sync_report_jobs where cycle_id=$1::uuid", [a.cycleId]),
      },
    };
  }
  const currentSlotNonUsCount = {}; const targetSlotCount = {};
  for (const a of ARCHIVE_CYCLES) {
    currentSlotNonUsCount[a.currentDate] = await one("select count(*)::int n from public.sync_cycles where bucket='non-us' and cycle_date=$1::date", [a.currentDate]);
    targetSlotCount[a.targetDate] = await one("select count(*)::int n from public.sync_cycles where cycle_date=$1::date and id <> all($2::uuid[])", [a.targetDate, ARCHIVE_CYCLES.map((x) => x.cycleId)]);
  }
  const controls = {
    allPrimary: (await q("select all_primary from public.scheduler_rollout_mode where id=1")).rows[0]?.all_primary,
    cron: await hasCron(),
    enabledRollout: await one("select count(*)::int n from public.scheduler_account_rollout where enabled=true"),
    enabledDispatch: await one("select count(*)::int n from public.report_sync_settings where schedule_enabled=true"),
    enabledPromoted: await one("select count(*)::int n from public.source_promoted_publish_settings where publish_enabled=true"),
    approvedCount: await one("select count(*)::int n from public.scheduler_publish_approvals where approved=true"),
  };
  const syncCyclesRowCount = await one("select count(*)::int n from public.sync_cycles");
  const digests = await captureDigests();
  return { cyclesById, currentSlotNonUsCount, targetSlotCount, controls, syncCyclesRowCount, digests };
};

const store = {
  readEvidence,
  begin: async () => { await q("begin"); await q("select pg_advisory_xact_lock($1::int, $2::int)", ADV); },
  commit: async () => { await q("commit"); },
  rollback: async () => { await q("rollback"); },
  update: async () => {
    const counts = [];
    for (const a of ARCHIVE_CYCLES) {
      // The ONLY write: move ONLY cycle_date, guarded by the exact frozen (id, bucket, current DATE, status).
      const r = await q("update public.sync_cycles set cycle_date=$2::date where id=$1::uuid and bucket=$3 and cycle_date=$4::date and status=$5", [a.cycleId, a.targetDate, a.expectedBucket, a.currentDate, a.expectedStatus]);
      counts.push(r.rowCount);
    }
    return counts;
  },
};

const printEvidence = (ev) => {
  for (const a of ARCHIVE_CYCLES) {
    const c = ev.cyclesById[a.cycleId];
    if (!c) { console.log("  " + a.cycleId.slice(0, 8) + " NOT FOUND"); continue; }
    console.log("  " + a.cycleId.slice(0, 8) + " " + c.bucket + " " + c.cycleDateText + " -> " + a.targetDate + " status=" + c.status + " trig=" + c.trigger + " src=" + c.counts.sourceJobs + " own=" + c.counts.owners + " rep=" + c.counts.reportJobs + " | currentSlot=" + ev.currentSlotNonUsCount[a.currentDate] + " targetFree=" + (ev.targetSlotCount[a.targetDate] === 0));
  }
  console.log("  controls: all_primary=" + ev.controls.allPrimary + " cron=" + ev.controls.cron + " rollout=" + ev.controls.enabledRollout + " dispatch=" + ev.controls.enabledDispatch + " promoted=" + ev.controls.enabledPromoted + " approvals=" + ev.controls.approvedCount + " | sync_cycles rows=" + ev.syncCyclesRowCount);
};

let result = { committed: false, code: 1 };
try {
  console.log("ARCHIVE-COLLISION-CYCLES mode=" + MODE + " cycles=" + ARCHIVE_CYCLES.length + " (2026-08-25..30 -> 2026-01-02..07)");
  if (MODE === "dry-run") {
    await q("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const ev = await readEvidence();
      printEvidence(ev);
      const problems = assessArchivePre(ev);
      result = await runArchiveTransaction({ store: { ...store, readEvidence: async () => ev }, mode: "dry-run" });
      if (problems.length) console.error("DRY RUN: NOT the exact expected collision set -> refusing. problems: " + problems.join("; "));
      else console.log("DRY RUN: EXACT expected collision set confirmed for all " + ARCHIVE_CYCLES.length + " cycles. Re-run with --apply to move ONLY cycle_date.");
    } finally { try { await q("ROLLBACK"); } catch { /* ignore */ } }
  } else {
    result = await runArchiveTransaction({ store, mode: "apply" });
    if (result.committed) console.log("COMMITTED archival of " + ARCHIVE_CYCLES.length + " cycles (only cycle_date moved).");
    else if (result.commitUnknown) { console.error("COMMIT_UNKNOWN: " + result.problem); console.error(result.instruction); }
    else console.error("REFUSED / ROLLED BACK: " + (result.problem || (result.problems || []).join("; ")) + (result.rollbackError ? " [rollback ALSO failed: " + result.rollbackError + "]" : ""));
  }
} catch (e) {
  try { await q("rollback"); } catch { /* ignore */ }
  console.error("archival failed before/around the transaction: " + (e && e.message));
  result = { code: 1 };
} finally {
  try { await client.end(); } catch { /* ignore */ }
}
process.exit(result.committed || result.dryRun ? 0 : (result.code === 3 ? 3 : 1));
