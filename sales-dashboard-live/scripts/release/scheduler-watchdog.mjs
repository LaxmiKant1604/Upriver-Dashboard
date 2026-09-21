// ===========================================================================
// DR4 SCHEDULER WATCHDOG -- audited, ZERO-EXPORT recovery of stalled sync cycles.
// ===========================================================================
//
// WHY. A scheduled full-region cycle stalls in status='running' FOREVER when its REQUIRED
// product-catalog job fails terminally at create-export -- most often the cross-bucket
// carrier-hash race (the sibling region wins the shared per-day catalog reservation with a
// DIFFERENT canonical carrier hash, so THIS region's create is refused
// PRIORITY_CATALOG_HASH_MISMATCH -> error_code EXPORT_ERROR, export_id NULL, ZERO tokens).
// The failed REQUIRED job -> globalDrained=false -> derive skipped -> 0 report jobs -> the
// cycle never finalizes, and a strict continuation only retries OPEN jobs, never a terminal
// FAILED one, so it is a permanent zombie. oli-refresh-d1 supersedes only TERMINAL cycles.
//
// WHAT THIS DOES (never a paid export; the DATA is published by the zero-export reconciler,
// which this watchdog is meant to run alongside):
//   1. DETECT (read-only): cycles status='running' AND stale (updated_at <= now()-STALE) and
//      NO OPEN (pending/attempted) source job -- i.e. done fetching and stuck, not mid-flight
//      (a live/fresh cycle is never touched).
//   2. RESUME (live): resume_stalled_catalog_job -> ATOMICALLY adopts the VALIDATED durable org
//      catalog snapshot for the failed catalog job (failed -> succeeded|durable_snapshot, no
//      pending window, zero tokens) so the cycle drains. A cycle with no adoptable snapshot is
//      left for finalize (partial), never fabricated.
//   3. FINALIZE (live): finalize_sync_cycle -> the reviewed running->terminal RPC. A drained
//      cycle (catalog now succeeded) -> 'succeeded'; a cycle whose catalog stayed failed ->
//      'partial'; a cycle still mid-flight -> 'open-work' (left running for a real continuation).
//      Never deletes, never touches export_id, never appends fabricated report data.
//
// SAFETY. DRY-RUN by default (reports the exact plan, ZERO writes). LIVE only with --live or
// SCHEDULER_WATCHDOG_LIVE=true. Every mutation is an audited, fenced, idempotent service_role
// RPC (resume_stalled_catalog_job 20260930 + finalize_sync_cycle 20260815). It NEVER creates a
// DataDoe export and prints creates/tokens=0. Per-region isolation: one region's failure never
// aborts another. 7-bit ASCII, LF.

import { loadReleaseEnv } from "./env-bootstrap.mjs";
loadReleaseEnv();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import pg from "pg";

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith("--" + name + "=")); return a ? a.split("=").slice(1).join("=") : null; };
const hasFlag = (name) => process.argv.includes("--" + name);

const REGIONS = ["india", "europe-au", "us-ca"];
const bucketArg = argOf("bucket");
const buckets = bucketArg ? [bucketArg] : REGIONS;
for (const b of buckets) if (!REGIONS.includes(b)) { console.error("STOP WATCHDOG_BUCKET_UNSUPPORTED: --bucket must be india|europe-au|us-ca (got " + b + ")"); process.exit(2); }
const live = hasFlag("live") || String(process.env.SCHEDULER_WATCHDOG_LIVE || "").toLowerCase() === "true";
// By DEFAULT recover ONLY cycles that have a NEWER TERMINAL sibling (definitely superseded -> safe to terminalize
// without disturbing the current slot or the daily scheduler). --include-current-slot also recovers the latest
// stalled cycle per bucket (still zero-export, but leaves it terminal for the scheduler's next D-1 supersede).
const supersededOnly = !hasFlag("include-current-slot");
const staleMinutes = Number(argOf("stale-minutes") || 45);
if (!(Number.isFinite(staleMinutes) && staleMinutes >= 20)) { console.error("STOP WATCHDOG_STALE_MINUTES: --stale-minutes must be a number >= 20 (guards against touching a live cycle); got " + staleMinutes); process.exit(2); }

const sb = await import("../../lib/server/supabase.js");
const pgBase = String(process.env.POSTGRES_URL || "").split("?")[0];
const db = new pg.Client({ connectionString: pgBase, ssl: { rejectUnauthorized: false } });
await db.connect();

console.log(`scheduler-watchdog: buckets=${buckets.join(",")} mode=${live ? "LIVE" : "DRY-RUN (read-only; zero writes)"} stale>=${staleMinutes}min scope=${supersededOnly ? "superseded-only (newer terminal sibling required)" : "include-current-slot"}`);

const staleBeforeIso = new Date(Date.now() - staleMinutes * 60_000).toISOString();
const summary = { examined: 0, resumed: 0, finalized: 0, openWork: 0, noSnapshot: 0, skipped: 0, byBucket: {}, dataDoeCreates: 0, dataDoeTokens: 0 };

for (const bucket of buckets) {
  const bs = { examined: 0, resumed: 0, finalized: 0, openWork: 0, noSnapshot: 0, skipped: 0, cycles: [] };
  summary.byBucket[bucket] = bs;
  try {
    // DETECT: stalled running cycles for this scheduled region bucket. A cycle with a NON-catalog open
    // (pending/attempted) job is genuinely mid-flight -> skipped. A cycle whose ONLY unfinished source is
    // an org product-catalog job (FAILED or still PENDING, export_id NULL -> zero tokens) is resumable.
    const { rows: stalled } = await db.query(
      `select c.id, c.cycle_date, c.updated_at,
              count(*) filter (where j.fetch_status in ('pending','attempted') and j.source_key <> 'product-catalog') as open_noncat,
              count(*) filter (where j.source_key='product-catalog' and j.fetch_status in ('failed','pending') and j.export_id is null and j.create_export_count <= 1) as unfinished_catalog,
              count(*) filter (where j.fetch_status='succeeded') as ok_jobs
         from public.sync_cycles c
         left join public.sync_source_jobs j on j.cycle_id = c.id
        where c.bucket = $1 and c.status = 'running' and c.updated_at <= $2
          and ($3::boolean = false or exists (
                select 1 from public.sync_cycles c2
                 where c2.bucket = c.bucket and c2.cycle_date > c.cycle_date
                   and c2.status in ('succeeded','partial','failed')))
        group by c.id, c.cycle_date, c.updated_at
        order by c.cycle_date`,
      [bucket, staleBeforeIso, supersededOnly],
    );
    for (const c of stalled) {
      bs.examined += 1; summary.examined += 1;
      const openNoncat = Number(c.open_noncat), unfinishedCatalog = Number(c.unfinished_catalog), okJobs = Number(c.ok_jobs);
      const rec = { cycle: String(c.id).slice(0, 8), date: c.cycle_date, openNoncat, unfinishedCatalog, okJobs, plan: null, resume: null, finalize: null };
      if (openNoncat > 0) { rec.plan = "skip-non-catalog-open-jobs (genuinely mid-flight OLI/FBA; not this operator's job)"; bs.skipped += 1; summary.skipped += 1; bs.cycles.push(rec); continue; }
      rec.plan = unfinishedCatalog > 0 ? "resume-catalog-then-finalize" : "finalize-only";
      if (!live) { bs.cycles.push(rec); continue; }

      // RESUME the unfinished (failed OR pending) catalog job from the durable snapshot (zero-export), if any.
      if (unfinishedCatalog > 0) {
        let ack = null;
        try { ack = await sb.resumeStalledCatalogJob({ cycleId: c.id, staleBefore: staleBeforeIso }); }
        catch (e) { ack = "error:" + (e && e.message ? e.message : e); }
        rec.resume = ack;
        if (ack === "resumed") { bs.resumed += 1; summary.resumed += 1; }
        else if (ack === "no-snapshot") { bs.noSnapshot += 1; summary.noSnapshot += 1; } // finalize will make it 'partial'
      }

      // FINALIZE the cycle via the reviewed running->terminal RPC (idempotent; open-work leaves it running).
      let fin = null;
      try { fin = await sb.finalizeSyncCycle(c.id); }
      catch (e) { fin = { disposition: "error:" + (e && e.message ? e.message : e) }; }
      const disp = fin && fin.disposition ? fin.disposition : "unknown";
      rec.finalize = disp + (fin && fin.cycle && fin.cycle.status ? "(" + fin.cycle.status + ")" : "");
      if (disp === "finalized" || disp === "already-terminal") { bs.finalized += 1; summary.finalized += 1; }
      else if (disp === "open-work") { bs.openWork += 1; summary.openWork += 1; }
      bs.cycles.push(rec);
    }
    console.log(`scheduler-watchdog: ${bucket} examined=${bs.examined} resumed=${bs.resumed} finalized=${bs.finalized} open-work=${bs.openWork} no-snapshot=${bs.noSnapshot} skipped=${bs.skipped}`);
    for (const r of bs.cycles) console.log(`  ${bucket} cyc=${r.cycle} date=${r.date} openNonCat=${r.openNoncat} unfinishedCat=${r.unfinishedCatalog} ok=${r.okJobs} plan=${r.plan}${live ? ` resume=${r.resume || "-"} finalize=${r.finalize || "-"}` : ""}`);
  } catch (e) {
    // PER-REGION ISOLATION: one region's failure never aborts the others.
    bs.error = e && e.message ? e.message : String(e);
    console.log(`scheduler-watchdog: ${bucket} ERROR (isolated) ${bs.error}`);
  }
}

console.log("RESULT " + JSON.stringify({ ok: true, mode: live ? "live" : "dry-run", staleMinutes, dataDoeCreates: 0, dataDoeTokens: 0, counts: { examined: summary.examined, resumed: summary.resumed, finalized: summary.finalized, openWork: summary.openWork, noSnapshot: summary.noSnapshot, skipped: summary.skipped }, byBucket: Object.fromEntries(Object.entries(summary.byBucket).map(([b, v]) => [b, { examined: v.examined, resumed: v.resumed, finalized: v.finalized, openWork: v.openWork, noSnapshot: v.noSnapshot, skipped: v.skipped, error: v.error || null }])) }));
await db.end();
process.exit(0);
