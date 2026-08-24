// Scheduler v2 -- REVIEWED one-shot re-date of the SINGLE historical Non-US cycle whose anomalous cycle_date
// collides with the priority go-live's Non-US slot. It moves ONLY that one row's cycle_date (a PostgreSQL DATE)
// from the current slot to the target date, changing NOTHING else. cycle_date is compared as a 'YYYY-MM-DD'
// string (cycle_date::text) -- NEVER through JS Date / toISOString (a DATE has no time or timezone).
//
// Phase-aware exactly like the other operators: a failure BEFORE the commit is attempted rolls back once (code
// 1); a lost commit acknowledgement is typed COMMIT_UNKNOWN (code 3) with NO rollback and NO retry.

// FROZEN identities (never dynamically adjusted).
export const REDATE = Object.freeze({
  cycleId: "481fe35c-ce65-455f-b317-cc267977e185",
  bucket: "non-us",
  currentDate: "2026-08-24",   // the colliding slot (DATE, as YYYY-MM-DD)
  // The archival target date (DATE, as YYYY-MM-DD). The natural Aug-16 slot is occupied by the real succeeded
  // Aug-16 Non-US cycle (and Aug 14-30 are all taken), so this reviewed value is a FREE, clearly-archival date.
  targetDate: "2026-01-16",
  expectedStatus: "partial",
  expectedTrigger: "manual",
  createdUtcDate: "2026-08-16",
  // exact child footprint of the historical Aug-16 test cycle (see the reviewed reconciliation).
  sourceJobs: 130,
  owners: 170,
  reportJobs: 13,
  validatedReportJobs: 3,
});

const S = (v) => (v == null ? "" : String(v));
// A cycle_date value must be an EXACT YYYY-MM-DD string. A timestamp/Date serialization (a "T", ":" or "Z", or
// anything longer than 10 chars) is REJECTED -- DATE comparison must never go through new Date().toISOString().
export function isPlainIsoDate(v) { return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v); }

const CONTROLS_CLOSED = (c) => c && c.allPrimary === false && c.cron === false
  && Number(c.enabledRollout) === 0 && Number(c.enabledDispatch) === 0
  && Number(c.enabledPromoted) === 0 && Number(c.approvedCount) === 0;
const V1_OK = (r) => r && S(r.status) === "reserved" && Number(r.tokens) === 0 && r.hasExport === false;
const V2_OK = (r) => r && S(r.status) === "created" && Number(r.tokens) === 2 && r.hasExport === true;

/**
 * Prove (read-only) the EXACT PRE state. Returns typed problems (empty === exactly the expected collision). The
 * bundle is store.readEvidence() output; see the CLI for its exact shape.
 */
export function assessRedatePre(bundle) {
  const P = [];
  const c = bundle && bundle.cycle;
  if (!c) return ["cycle-not-found"];
  if (S(c.id) !== REDATE.cycleId) P.push("wrong-cycle-id");
  if (S(c.bucket) !== REDATE.bucket) P.push("wrong-bucket:" + S(c.bucket));
  // DATE identity is a plain YYYY-MM-DD string comparison (never a Date serialization).
  if (!isPlainIsoDate(c.cycleDateText)) P.push("cycle-date-not-plain-iso:" + S(c.cycleDateText));
  else if (c.cycleDateText !== REDATE.currentDate) P.push("cycle-date-not-current-slot:" + S(c.cycleDateText));
  if (S(c.status) !== REDATE.expectedStatus) P.push("status-not-expected:" + S(c.status));
  if (S(c.trigger) !== REDATE.expectedTrigger) P.push("trigger-not-manual:" + S(c.trigger));
  if (c.finishedAtNonNull !== true) P.push("finished_at-null");
  if (S(c.createdUtcDate) !== REDATE.createdUtcDate) P.push("created_at-not-historical:" + S(c.createdUtcDate));

  const n = bundle.counts || {};
  if (Number(n.sourceJobs) !== REDATE.sourceJobs) P.push("source-jobs-count:" + S(n.sourceJobs));
  if (Number(n.owners) !== REDATE.owners) P.push("owners-count:" + S(n.owners));
  if (Number(n.reportJobs) !== REDATE.reportJobs) P.push("report-jobs-count:" + S(n.reportJobs));
  if (Number(n.validatedReportJobs) !== REDATE.validatedReportJobs) P.push("validated-report-jobs-count:" + S(n.validatedReportJobs));

  if (Number(bundle.v2LineageCount) !== 0) P.push("v2-lineage-present:" + S(bundle.v2LineageCount));
  if (Number(bundle.targetSlotCount) !== 0) P.push("target-slot-occupied:" + S(bundle.targetSlotCount));
  if (Number(bundle.nonUsAtCurrentCount) !== 1) P.push("current-slot-not-exactly-this-cycle:" + S(bundle.nonUsAtCurrentCount));

  if (!CONTROLS_CLOSED(bundle.controls)) P.push("controls-not-safe-closed");
  if (!V1_OK(bundle.reservations && bundle.reservations.v1)) P.push("v1-reservation-not-exact");
  if (!V2_OK(bundle.reservations && bundle.reservations.v2)) P.push("v2-reservation-not-exact");
  return P;
}

const DIGEST_KEYS = ["live_snapshots", "shadow_snapshots", "rollout", "mode", "approvals", "settings", "sync_cycles", "report_jobs"];

/**
 * Prove the EXACT POST state after the guarded UPDATE, before COMMIT. Compares the POST bundle to the PRE bundle:
 * exactly one row changed cycle_date to the target; the current slot has no Non-US cycle; every child count /
 * counter / status is byte-identical; reservations + controls unchanged; and of the eight protected digests only
 * sync_cycles changed while its row COUNT stayed identical. Returns typed problems (empty === correct).
 */
export function assessRedatePost(pre, post, rowCount) {
  const P = [];
  if (Number(rowCount) !== 1) P.push("row-count-not-1:" + S(rowCount));
  const c = post && post.cycle;
  if (!c) { P.push("post-cycle-missing"); return P; }
  if (!isPlainIsoDate(c.cycleDateText) || c.cycleDateText !== REDATE.targetDate) P.push("post-cycle-date-not-target:" + S(c.cycleDateText));
  if (Number(post.nonUsAtCurrentCount) !== 0) P.push("current-slot-still-has-nonus:" + S(post.nonUsAtCurrentCount));

  // Every child count byte-identical.
  for (const k of ["sourceJobs", "owners", "reportJobs", "validatedReportJobs"]) {
    if (Number(post.counts[k]) !== Number(pre.counts[k])) P.push("child-count-changed:" + k);
  }
  // Cycle counters + status + trigger + finished_at byte-identical (ONLY cycle_date may change).
  const pc = pre.cycle.counters || {}; const qc = c.counters || {};
  for (const k of Object.keys(pc)) if (Number(pc[k]) !== Number(qc[k])) P.push("counter-changed:" + k);
  if (S(c.status) !== S(pre.cycle.status)) P.push("status-changed");
  if (S(c.trigger) !== S(pre.cycle.trigger)) P.push("trigger-changed");
  if (c.finishedAtNonNull !== pre.cycle.finishedAtNonNull) P.push("finished_at-changed");

  if (!V1_OK(post.reservations && post.reservations.v1)) P.push("v1-reservation-changed");
  if (!V2_OK(post.reservations && post.reservations.v2)) P.push("v2-reservation-changed");
  if (!CONTROLS_CLOSED(post.controls)) P.push("controls-changed");

  // Protected digests: seven byte-identical; only sync_cycles may change; its row COUNT stays identical.
  for (const key of DIGEST_KEYS) {
    const a = pre.digests[key]; const b = post.digests[key];
    if (!a || !b) { P.push("digest-missing:" + key); continue; }
    if (key === "sync_cycles") {
      if (Number(a.c) !== Number(b.c)) P.push("sync_cycles-row-count-changed:" + a.c + "->" + b.c);
    } else if (a.c !== b.c || a.h !== b.h) {
      P.push("protected-digest-changed:" + key);
    }
  }
  return P;
}

/**
 * Run the re-date. `store` contract (async): begin()/commit()/rollback(); readEvidence() -> bundle;
 * update() -> rowCount (the ONE guarded UPDATE). Dry-run reads + assesses PRE and writes nothing.
 * Returns { committed, mode, code, problems?, problem?, instruction?, syncCyclesDigest? }.
 */
export async function runRedateCollisionTransaction({ store, mode = "dry-run" } = {}) {
  if (!store || typeof store.readEvidence !== "function" || typeof store.begin !== "function") throw new Error("runRedateCollisionTransaction requires a transactional store (fail closed).");
  if (mode !== "apply" && mode !== "dry-run") throw new Error("mode must be 'apply' | 'dry-run' (fail closed).");

  if (mode === "dry-run") {
    const ev = await store.readEvidence();
    const problems = assessRedatePre(ev);
    return { committed: false, mode: "dry-run", code: problems.length ? 1 : 0, dryRun: problems.length === 0, problems, syncCyclesDigest: ev.digests && ev.digests.sync_cycles };
  }

  let phase = "pre-commit";
  await store.begin();
  try {
    const pre = await store.readEvidence();
    const preProblems = assessRedatePre(pre);
    if (preProblems.length) throw new Error("PRE: " + preProblems.join("; "));
    const rowCount = await store.update();
    const post = await store.readEvidence();
    const postProblems = assessRedatePost(pre, post, rowCount);
    if (postProblems.length) throw new Error("POST: " + postProblems.join("; "));
    phase = "commit";
    await store.commit();
    return { committed: true, mode: "apply", code: 0, syncCyclesDigest: post.digests.sync_cycles };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (phase === "commit") {
      return { committed: false, mode: "apply", code: 3, commitUnknown: true, problem: "COMMIT_UNKNOWN: " + msg,
        instruction: "The COMMIT acknowledgement was lost; the cycle_date state is UNKNOWN. Run a READ-ONLY reconciliation BEFORE any retry. Do NOT retry or rollback blindly." };
    }
    let rollbackError = null;
    try { await store.rollback(); } catch (re) { rollbackError = (re && re.message) || String(re); }
    return { committed: false, mode: "apply", code: 1, problem: msg, ...(rollbackError ? { rollbackError } : {}) };
  }
}
