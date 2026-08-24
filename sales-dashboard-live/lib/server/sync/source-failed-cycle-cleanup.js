// Scheduler v2 -- REVIEWED one-shot cleanup of a SINGLE failed priority (v1) Catalog cycle, so a same-date v2
// cycle can open cleanly. It is DELIBERATELY narrow: it deletes ONLY the exact footprint of ONE cycle whose PRE
// proof shows it is a benign failed-Catalog-only cycle -- exactly one product-catalog source job that FAILED at
// create-export with NO export id, NO succeeded source job, NO report job, NO snapshot, and only the one org
// Catalog owner (plus at most that family's budget). It NEVER touches the durable Catalog reservation, any
// report/live/shadow snapshot, OLI history, controls, or any unrelated cycle/job/owner/budget row. If ANY PRE
// assertion fails it makes ZERO writes and returns the mismatch.
//
// The transaction is phase-aware exactly like the control package: a failure BEFORE the commit is attempted
// performs one rollback and returns an ordinary failure (code 1); a lost/failed commit ack returns typed
// COMMIT_UNKNOWN (code 3) with NO rollback and NO retry, demanding a read-only reconciliation.

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";

/**
 * PROVE (read-only) that `cycleId` is EXACTLY the benign failed-Catalog-only footprint. Returns an array of typed
 * problems (empty === the exact expected footprint). `snap` is the read bundle:
 *   { cycle, sourceJobs, owners, reportJobs, budgets, snapshotCount }.
 */
export function assessFailedCatalogCycle(cycleId, snap, { organizationScopeKey } = {}) {
  const P = [];
  const cyc = snap && snap.cycle;
  if (!cyc || S(cyc.id) !== S(cycleId)) return ["cycle-not-found"];
  if (cyc.bucket !== "us" && cyc.bucket !== "non-us") P.push("bad-bucket:" + S(cyc.bucket));
  if (S(cyc.status) !== "running") P.push("cycle-not-running:" + S(cyc.status)); // a terminal cycle is NEVER cleaned
  if (S(cyc.trigger) !== "manual") P.push("cycle-not-manual:" + S(cyc.trigger));

  const jobs = Array.isArray(snap.sourceJobs) ? snap.sourceJobs : null;
  if (!jobs) P.push("source-jobs-unreadable");
  else {
    if (jobs.length !== 1) P.push("source-job-count:" + jobs.length);
    for (const j of jobs) {
      if (S(j.source_key ?? j.sourceKey) !== "product-catalog") P.push("non-catalog-source-job");
      if (S(j.fetch_status ?? j.fetchStatus) === "succeeded") P.push("has-succeeded-source-job");
      if (S(j.fetch_status ?? j.fetchStatus) !== "failed") P.push("source-job-not-failed:" + S(j.fetch_status ?? j.fetchStatus));
      if ((j.terminal ?? j.isTerminal) !== true) P.push("source-job-not-terminal");
      if (nb(S(j.export_id ?? j.exportId))) P.push("has-datadoe-export-id"); // a real export must NOT exist
      if (S(j.error_stage ?? j.errorStage) !== "create-export") P.push("error-stage-not-create-export:" + S(j.error_stage ?? j.errorStage));
    }
  }

  const reportJobs = Array.isArray(snap.reportJobs) ? snap.reportJobs : null;
  if (!reportJobs) P.push("report-jobs-unreadable");
  else if (reportJobs.length !== 0) P.push("has-report-jobs:" + reportJobs.length); // no report job / no validated derive / no publication

  const owners = Array.isArray(snap.owners) ? snap.owners : null;
  if (!owners) P.push("owners-unreadable");
  else {
    if (owners.length !== 1) P.push("owner-count:" + owners.length);
    for (const o of owners) {
      if (organizationScopeKey != null && S(o.account_id ?? o.accountId) !== S(organizationScopeKey)) P.push("owner-not-org-scope");
    }
  }

  if (typeof snap.snapshotCount === "number" && snap.snapshotCount !== 0) P.push("has-snapshots:" + snap.snapshotCount);

  const budgets = Array.isArray(snap.budgets) ? snap.budgets : [];
  for (const b of budgets) {
    // A budget row for THIS cycle's Catalog family is part of the footprint; but it must never record a REAL
    // spent create/token beyond the single attempted (and failed) create.
    if (Number(b.spent_tokens ?? b.spentTokens ?? 0) > 0) P.push("budget-recorded-token-spend");
    if (Number(b.spent_creates ?? b.spentCreates ?? 0) > 1) P.push("budget-multiple-creates");
  }
  return P;
}

/**
 * Run the guarded one-shot cleanup transaction. `store` contract (async):
 *   begin(cycleId) / commit() / rollback()  -- open/commit/abort under a dedicated advisory lock
 *   read(cycleId) -> { cycle, sourceJobs, owners, reportJobs, budgets, snapshotCount }
 *   deleteFootprint(cycleId) -> void  -- delete ONLY this cycle's owners, source jobs, budgets, (empty) report
 *                                        jobs, then the cycle row; NEVER the reservation / snapshots / OLI / etc.
 * Returns { committed, mode, code, problems?, problem?, instruction? }. mode is "apply" | "dry-run".
 */
export async function runFailedCycleCleanupTransaction({ store, cycleId, mode = "dry-run", organizationScopeKey } = {}) {
  if (!store || typeof store.begin !== "function" || typeof store.read !== "function") throw new Error("runFailedCycleCleanupTransaction requires a transactional store (fail closed).");
  if (!nb(cycleId)) throw new Error("runFailedCycleCleanupTransaction requires an exact cycleId (fail closed).");
  if (mode !== "apply" && mode !== "dry-run") throw new Error("mode must be 'apply' | 'dry-run' (fail closed).");

  // PRE: read-only assessment. A DRY RUN reports the assessment and writes NOTHING.
  const pre = await store.read(cycleId);
  const problems = assessFailedCatalogCycle(cycleId, pre, { organizationScopeKey });
  if (problems.length) return { committed: false, mode, code: 1, problems, problem: "PRE mismatch: " + problems.join("; ") };
  if (mode === "dry-run") return { committed: false, mode: "dry-run", code: 0, dryRun: true, assessment: "exact-benign-failed-catalog-cycle" };

  let phase = "pre-commit";
  await store.begin(cycleId);
  try {
    // Re-assert the exact footprint INSIDE the transaction (under the advisory lock) before deleting anything.
    const locked = await store.read(cycleId);
    const p2 = assessFailedCatalogCycle(cycleId, locked, { organizationScopeKey });
    if (p2.length) throw new Error("PRE (locked) mismatch: " + p2.join("; "));

    await store.deleteFootprint(cycleId);

    // POST: the cycle and EVERY child row are gone; nothing else is asserted deleted.
    const post = await store.read(cycleId);
    if (post && post.cycle) throw new Error("POST: the cycle still exists after delete");
    if ((post && Array.isArray(post.sourceJobs) ? post.sourceJobs.length : 0) !== 0) throw new Error("POST: source jobs remain");
    if ((post && Array.isArray(post.owners) ? post.owners.length : 0) !== 0) throw new Error("POST: owners remain");
    if ((post && Array.isArray(post.reportJobs) ? post.reportJobs.length : 0) !== 0) throw new Error("POST: report jobs remain");

    phase = "commit";
    await store.commit();
    return { committed: true, mode: "apply", code: 0 };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (phase === "commit") {
      return { committed: false, mode: "apply", code: 3, commitUnknown: true, problem: "COMMIT_UNKNOWN: " + msg,
        instruction: "The COMMIT acknowledgement was lost; the cycle-cleanup state is UNKNOWN. Run a READ-ONLY reconciliation BEFORE any retry. Do NOT retry or rollback blindly." };
    }
    let rollbackError = null;
    try { await store.rollback(); } catch (re) { rollbackError = (re && re.message) || String(re); }
    return { committed: false, mode: "apply", code: 1, problem: msg, ...(rollbackError ? { rollbackError } : {}) };
  }
}
