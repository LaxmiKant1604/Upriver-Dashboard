// Scheduler v2 -- REVIEWED fixed-identity archival of the SIX future-dated Non-US cycles whose anomalous
// cycle_date values occupy the scheduler's upcoming daily slots (2026-08-25 .. 2026-08-30) and would each cause a
// deterministic scheduled-run failure. It moves ONLY each row's cycle_date (a PostgreSQL DATE) from its current
// future slot to a FROZEN, unoccupied January-2026 archival date -- changing NOTHING else (never a delete /
// reset / reopen of any cycle, job, owner, report, snapshot or history row, never a control). cycle_date is
// compared as a plain 'YYYY-MM-DD' string (cycle_date::text) -- NEVER through JS Date / toISOString.
//
// Phase-aware: a failure BEFORE the commit rolls back once (code 1); a lost commit ack is typed COMMIT_UNKNOWN
// (code 3), NO rollback, NO retry.

// FROZEN identities + exact child footprints (from the reviewed read-only reconciliation; never dynamic).
export const ARCHIVE_CYCLES = Object.freeze([
  Object.freeze({ cycleId: "d8c83cf6-2c66-4dc7-8c41-9d2f95fbd93a", expectedBucket: "non-us", currentDate: "2026-08-25", targetDate: "2026-01-02", expectedStatus: "partial", expectedTrigger: "manual", sourceJobCount: 130, ownerCount: 170, reportJobCount: 13 }),
  Object.freeze({ cycleId: "09f7f742-81a0-4a0b-b5c3-8cd508398491", expectedBucket: "non-us", currentDate: "2026-08-26", targetDate: "2026-01-03", expectedStatus: "partial", expectedTrigger: "manual", sourceJobCount: 125, ownerCount: 167, reportJobCount: 13 }),
  Object.freeze({ cycleId: "f061aa95-f985-428b-973e-7c69c0b4d7cb", expectedBucket: "non-us", currentDate: "2026-08-27", targetDate: "2026-01-04", expectedStatus: "partial", expectedTrigger: "manual", sourceJobCount: 124, ownerCount: 161, reportJobCount: 13 }),
  Object.freeze({ cycleId: "87819e6b-cb46-4cd0-9a63-3e981136201b", expectedBucket: "non-us", currentDate: "2026-08-28", targetDate: "2026-01-05", expectedStatus: "partial", expectedTrigger: "manual", sourceJobCount: 124, ownerCount: 161, reportJobCount: 13 }),
  Object.freeze({ cycleId: "768eb243-17e6-4683-b543-397598efcb0e", expectedBucket: "non-us", currentDate: "2026-08-29", targetDate: "2026-01-06", expectedStatus: "running", expectedTrigger: "manual", sourceJobCount: 10, ownerCount: 44, reportJobCount: 0 }),
  Object.freeze({ cycleId: "15d1f749-3d81-4994-b52a-2fb47d1d4bf4", expectedBucket: "non-us", currentDate: "2026-08-30", targetDate: "2026-01-07", expectedStatus: "running", expectedTrigger: "manual", sourceJobCount: 17, ownerCount: 65, reportJobCount: 0 }),
]);

// Protected tables whose digests (row count + content hash) MUST be byte-identical across the whole archival: no
// publication / control / schedule / approval / live-snapshot / durable-history row may change.
export const PROTECTED_TABLES = Object.freeze([
  "report_snapshots", "scheduler_account_rollout", "scheduler_rollout_mode", "scheduler_publish_approvals",
  "report_sync_settings", "source_controls", "source_promoted_publish_settings",
  "source_oli_daily_history", "ads_daily_source_rows", "ads_sync_coverage",
]);

const S = (v) => (v == null ? "" : String(v));
export function isPlainIsoDate(v) { return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v); }
const CONTROLS_CLOSED = (c) => c && c.allPrimary === false && c.cron === false
  && Number(c.enabledRollout) === 0 && Number(c.enabledDispatch) === 0
  && Number(c.enabledPromoted) === 0 && Number(c.approvedCount) === 0;

// Structural invariants of the frozen set itself (distinct ids, distinct current+target dates, target != current,
// all plain ISO dates). Returns typed problems (empty === coherent). Guards a future mis-edit of ARCHIVE_CYCLES.
export function assessFrozenSetCoherent(cycles = ARCHIVE_CYCLES) {
  const P = [];
  const ids = new Set(); const cur = new Set(); const tgt = new Set();
  for (const a of cycles) {
    if (ids.has(a.cycleId)) P.push("duplicate-cycle-id"); ids.add(a.cycleId);
    if (!isPlainIsoDate(a.currentDate)) P.push("current-date-not-iso:" + a.currentDate);
    if (!isPlainIsoDate(a.targetDate)) P.push("target-date-not-iso:" + a.targetDate);
    if (a.currentDate === a.targetDate) P.push("target-equals-current:" + a.cycleId);
    if (cur.has(a.currentDate)) P.push("duplicate-current-date:" + a.currentDate); cur.add(a.currentDate);
    if (tgt.has(a.targetDate)) P.push("duplicate-target-date:" + a.targetDate); tgt.add(a.targetDate);
  }
  return P;
}

/**
 * Prove (read-only) the EXACT PRE state for ALL frozen cycles. `bundle` = store.readEvidence() output:
 *   cyclesById: Map/obj cycleId -> { id, bucket, cycleDateText, status, trigger, counts:{sourceJobs,owners,reportJobs} }
 *   currentSlotNonUsCount: obj currentDate -> count of non-us cycles at that date (must be exactly 1: this cycle)
 *   targetSlotCount:       obj targetDate  -> count of ANY cycles at that date (must be 0: free)
 *   controls, digests, syncCyclesRowCount.
 * Returns typed problems (empty === exactly the expected collision set).
 */
export function assessArchivePre(bundle, cycles = ARCHIVE_CYCLES) {
  const P = [];
  P.push(...assessFrozenSetCoherent(cycles));
  const byId = bundle && bundle.cyclesById ? bundle.cyclesById : {};
  const get = (id) => (byId instanceof Map ? byId.get(id) : byId[id]);
  for (const a of cycles) {
    const c = get(a.cycleId);
    if (!c) { P.push("cycle-not-found:" + a.cycleId.slice(0, 8)); continue; }
    if (S(c.bucket) !== a.expectedBucket) P.push("wrong-bucket:" + a.cycleId.slice(0, 8) + ":" + S(c.bucket));
    if (!isPlainIsoDate(c.cycleDateText)) P.push("cycle-date-not-plain-iso:" + a.cycleId.slice(0, 8));
    else if (c.cycleDateText !== a.currentDate) P.push("cycle-date-not-current-slot:" + a.cycleId.slice(0, 8) + ":" + S(c.cycleDateText));
    if (S(c.status) !== a.expectedStatus) P.push("status-not-expected:" + a.cycleId.slice(0, 8) + ":" + S(c.status));
    if (S(c.trigger) !== a.expectedTrigger) P.push("trigger-not-expected:" + a.cycleId.slice(0, 8) + ":" + S(c.trigger));
    const n = c.counts || {};
    if (Number(n.sourceJobs) !== a.sourceJobCount) P.push("source-jobs-count:" + a.cycleId.slice(0, 8) + ":" + S(n.sourceJobs));
    if (Number(n.owners) !== a.ownerCount) P.push("owners-count:" + a.cycleId.slice(0, 8) + ":" + S(n.owners));
    if (Number(n.reportJobs) !== a.reportJobCount) P.push("report-jobs-count:" + a.cycleId.slice(0, 8) + ":" + S(n.reportJobs));
    // current slot holds EXACTLY this one non-us cycle; target slot is free.
    const cs = bundle.currentSlotNonUsCount || {};
    if (Number(cs[a.currentDate]) !== 1) P.push("current-slot-not-exactly-one:" + a.currentDate + ":" + S(cs[a.currentDate]));
    const ts = bundle.targetSlotCount || {};
    if (Number(ts[a.targetDate]) !== 0) P.push("target-slot-occupied:" + a.targetDate + ":" + S(ts[a.targetDate]));
  }
  if (!CONTROLS_CLOSED(bundle.controls)) P.push("controls-not-safe-closed");
  return P;
}

/**
 * Prove the EXACT POST state after the guarded UPDATEs, before COMMIT. `rowCounts` = array of per-cycle UPDATE row
 * counts (each MUST be 1). Compares POST to PRE: each cycle is now at its target date; every original slot has zero
 * non-us cycles; every child count is byte-identical; controls unchanged; sync_cycles row COUNT unchanged; and
 * every PROTECTED_TABLES digest is byte-identical (no snapshot / control / OLI history / Ads history row changed).
 * Returns typed problems (empty === correct).
 */
export function assessArchivePost(pre, post, rowCounts, cycles = ARCHIVE_CYCLES) {
  const P = [];
  if (!Array.isArray(rowCounts) || rowCounts.length !== cycles.length) P.push("row-counts-shape:" + (Array.isArray(rowCounts) ? rowCounts.length : "na"));
  else for (let i = 0; i < rowCounts.length; i += 1) if (Number(rowCounts[i]) !== 1) P.push("row-count-not-1:" + cycles[i].cycleId.slice(0, 8) + ":" + S(rowCounts[i]));
  const preById = pre && pre.cyclesById ? pre.cyclesById : {};
  const postById = post && post.cyclesById ? post.cyclesById : {};
  const g = (m, id) => (m instanceof Map ? m.get(id) : m[id]);
  for (const a of cycles) {
    const c = g(postById, a.cycleId);
    if (!c) { P.push("post-cycle-missing:" + a.cycleId.slice(0, 8)); continue; }
    if (!isPlainIsoDate(c.cycleDateText) || c.cycleDateText !== a.targetDate) P.push("post-cycle-date-not-target:" + a.cycleId.slice(0, 8) + ":" + S(c.cycleDateText));
    const pcy = g(preById, a.cycleId) || {}; const pn = pcy.counts || {}; const qn = c.counts || {};
    for (const k of ["sourceJobs", "owners", "reportJobs"]) if (Number(pn[k]) !== Number(qn[k])) P.push("child-count-changed:" + a.cycleId.slice(0, 8) + ":" + k);
    if (S(c.status) !== S(pcy.status)) P.push("status-changed:" + a.cycleId.slice(0, 8));
    if (S(c.trigger) !== S(pcy.trigger)) P.push("trigger-changed:" + a.cycleId.slice(0, 8));
    // original slot now free; target slot has exactly one cycle.
    if (Number((post.currentSlotNonUsCount || {})[a.currentDate]) !== 0) P.push("original-slot-still-nonus:" + a.currentDate);
    if (Number((post.targetSlotCount || {})[a.targetDate]) !== 1) P.push("target-slot-not-exactly-one:" + a.targetDate);
  }
  if (Number(post.syncCyclesRowCount) !== Number(pre.syncCyclesRowCount)) P.push("sync_cycles-row-count-changed:" + S(pre.syncCyclesRowCount) + "->" + S(post.syncCyclesRowCount));
  if (!CONTROLS_CLOSED(post.controls)) P.push("controls-changed");
  for (const key of PROTECTED_TABLES) {
    const a = (pre.digests || {})[key]; const b = (post.digests || {})[key];
    if (!a || !b) { P.push("digest-missing:" + key); continue; }
    if (a.c !== b.c || a.h !== b.h) P.push("protected-digest-changed:" + key);
  }
  return P;
}

/**
 * Run the archival. `store` (async): begin()/commit()/rollback(); readEvidence() -> bundle; update() -> per-cycle
 * row counts (array). Dry-run reads + assesses PRE and writes nothing. Returns { committed, mode, code, ... }.
 */
export async function runArchiveTransaction({ store, mode = "dry-run" } = {}) {
  if (!store || typeof store.readEvidence !== "function" || typeof store.begin !== "function") throw new Error("runArchiveTransaction requires a transactional store (fail closed).");
  if (mode !== "apply" && mode !== "dry-run") throw new Error("mode must be 'apply' | 'dry-run' (fail closed).");

  if (mode === "dry-run") {
    const ev = await store.readEvidence();
    const problems = assessArchivePre(ev);
    return { committed: false, mode: "dry-run", code: problems.length ? 1 : 0, dryRun: problems.length === 0, problems };
  }

  let phase = "pre-commit";
  await store.begin();
  try {
    const pre = await store.readEvidence();
    const preProblems = assessArchivePre(pre);
    if (preProblems.length) throw new Error("PRE: " + preProblems.join("; "));
    const rowCounts = await store.update();
    const post = await store.readEvidence();
    const postProblems = assessArchivePost(pre, post, rowCounts);
    if (postProblems.length) throw new Error("POST: " + postProblems.join("; "));
    phase = "commit";
    await store.commit();
    return { committed: true, mode: "apply", code: 0 };
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
