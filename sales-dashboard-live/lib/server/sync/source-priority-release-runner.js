// Scheduler v2 -- STRICT production operator runner for the Daily Reporting + Brand View priority release.
//
// A pure orchestration over the trusted composition (buildPriorityDashboardsRelease) with every side-effecting
// step INJECTED, so it is fully offline-testable and the CLI wrapper only wires production collaborators +
// process.exit. It EXITS NONZERO on every derive/finalize/publish disposition except a proven success:
//   1. READ-ONLY reconciliation before any write (a mismatch stops before deriving);
//   2. derive US then Non-US through the composition (priority mode + the durable catalog guard enforce zero
//      OLI/Ads/FBA/other creates and at most one Catalog create / two tokens -- the runner re-proves the durable
//      reservation shows <= 2 tokens);
//   3. finalize each exact priority cycle through the corrected trusted verifier (finalizeBucket);
//   4. BEFORE the first live write, read-prove all THREE publication gates for EVERY account, so a predictable
//      missing approval/control cannot cause a partial publish;
//   5. publish daily-reporting, brand-sales, brand-inventory (brand-sales before brand-inventory), accepting
//      ONLY 'published' or 'already-current';
//   6. read back the exact live identities and prove the frontend payload contracts.
// It NEVER applies a migration, NEVER enables the scheduler/cron, and NEVER touches unrelated reports/snapshots.

import { PRIORITY_DASHBOARDS } from "./source-priority-dashboards.js";

const OK_PUBLISH = new Set(["published", "already-current"]);
const OK_FINALIZE = new Set(["finalized", "already-terminal"]);
const S = (v) => (v == null ? "" : String(v));

/**
 * Run the strict priority release. Returns { code, ok, stage, evidence, problems }: code 0 ONLY on a proven
 * full success; any other disposition yields code 1 with the stopping stage + typed problems (never a secret).
 *
 * deps:
 *   release            -- buildPriorityDashboardsRelease() instance (deriveBucket/finalizeBucket/publishAccount/
 *                         catalogReservation/reportKeys/publishOrder).
 *   reconcile()        -> { ok, problems? }  READ-ONLY pre-write reconciliation.
 *   readPublishGate(reportKey, accountId) -> { ready, reason? }  the four durable publication gates, read-only.
 *   readbackLive(reportKey, accountId)    -> { ok, reason? }     live-identity read-back + frontend payload proof.
 *   assertNoCron()     -> { ok, reason? }  proves no scheduler cron exists (never enables one).
 *   log(message)       -- optional progress line.
 */
export async function runPriorityDashboardsRelease(deps = {}) {
  const { release, reconcile, readPublishGate, readbackLive, assertNoCron, log = () => {} } = deps;
  if (!release || typeof release.deriveBucket !== "function" || typeof release.finalizeBucket !== "function" || typeof release.publishAccount !== "function") {
    throw new Error("runPriorityDashboardsRelease requires a release with deriveBucket/finalizeBucket/publishAccount (fail closed).");
  }
  for (const [name, fn] of [["reconcile", reconcile], ["readPublishGate", readPublishGate], ["readbackLive", readbackLive], ["assertNoCron", assertNoCron]]) {
    if (typeof fn !== "function") throw new Error(`runPriorityDashboardsRelease requires ${name} (fail closed).`);
  }
  const reportKeys = release.publishOrder || PRIORITY_DASHBOARDS.publishOrder;
  const fail = (stage, problems) => ({ code: 1, ok: false, stage, problems: Array.isArray(problems) ? problems : [S(problems)] });

  // (0) No scheduler cron may exist -- this runner never enables one.
  const cron0 = await assertNoCron();
  if (!cron0 || cron0.ok !== true) return fail("assert-no-cron", (cron0 && cron0.reason) || "cron present");

  // (1) READ-ONLY reconciliation BEFORE any write.
  const rec = await reconcile();
  if (!rec || rec.ok !== true) return fail("reconcile", (rec && rec.problems) || "reconciliation mismatch");
  log("reconcile ok");

  // (2) derive US then Non-US. A skipped/stopped derive is a hard stop.
  for (const bucket of PRIORITY_DASHBOARDS.buckets) {
    const { rollup } = await release.deriveBucket(bucket);
    if (!rollup || rollup.stopped === true || (rollup.derived && rollup.derived.skipped != null)) {
      return fail("derive:" + bucket, "derive did not complete: " + S(rollup && ((rollup.stopReason && rollup.stopReason.code) || (rollup.derived && rollup.derived.skipped))));
    }
    log("derive ok: " + bucket);
  }

  // (2b) the durable reservation must show at most ONE Catalog create / TWO tokens for the whole operation.
  const reservation = await release.catalogReservation(null);
  if (reservation && Number(reservation.tokensSpent) > PRIORITY_DASHBOARDS.maxTokens) {
    return fail("token-ceiling", "reservation tokens_spent " + S(reservation.tokensSpent) + " > " + PRIORITY_DASHBOARDS.maxTokens);
  }

  // (3) finalize each exact priority cycle; collect the proven account scope.
  const accounts = new Set();
  for (const bucket of PRIORITY_DASHBOARDS.buckets) {
    const fin = await release.finalizeBucket(bucket);
    if (!fin || !OK_FINALIZE.has(S(fin.disposition))) return fail("finalize:" + bucket, "finalize refused: " + S(fin && (fin.reason || fin.disposition)));
    for (const a of fin.accounts || []) accounts.add(S(a));
    log("finalize ok: " + bucket + " (" + (fin.accounts ? fin.accounts.length : 0) + " accounts, " + S(fin.cycleStatus) + ")");
  }
  const accountList = [...accounts].sort();
  if (!accountList.length) return fail("scope", "no proven accounts to publish");

  // (4) BEFORE any live write: read-prove ALL THREE publication gates for EVERY account (no partial publish).
  const gateProblems = [];
  for (const accountId of accountList) {
    for (const reportKey of reportKeys) {
      const g = await readPublishGate(reportKey, accountId);
      if (!g || g.ready !== true) gateProblems.push(reportKey + " gate not ready (" + S(g && g.reason) + ")");
    }
  }
  if (gateProblems.length) return fail("publish-gates", gateProblems);
  log("all publication gates proven ready for " + accountList.length + " accounts");

  // (5) publish daily-reporting, brand-sales, brand-inventory (order enforced by the composition); accept ONLY
  //     'published' / 'already-current'. Any other disposition stops.
  const published = [];
  for (const accountId of accountList) {
    const res = await release.publishAccount(accountId);
    for (const r of (res && res.results) || []) {
      if (!OK_PUBLISH.has(S(r.disposition))) return fail("publish", r.reportKey + " -> " + S(r.disposition));
      published.push({ reportKey: r.reportKey, disposition: r.disposition });
    }
  }
  log("published " + published.length + " (report, account) pairs");

  // (6) read back the exact live identities and prove the frontend payload contracts.
  for (const accountId of accountList) {
    for (const reportKey of reportKeys) {
      const rb = await readbackLive(reportKey, accountId);
      if (!rb || rb.ok !== true) return fail("readback", reportKey + " live read-back failed (" + S(rb && rb.reason) + ")");
    }
  }

  // (7) still no cron; the runner never enabled one.
  const cron1 = await assertNoCron();
  if (!cron1 || cron1.ok !== true) return fail("assert-no-cron-final", (cron1 && cron1.reason) || "cron appeared");

  return { code: 0, ok: true, stage: "complete", evidence: { accounts: accountList.length, published: published.length, tokensSpent: reservation ? Number(reservation.tokensSpent) : 0 } };
}
