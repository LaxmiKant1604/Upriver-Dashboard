// Scheduler v2 -- STRICT production operator runner for the Daily Reporting + Brand View priority release.
//
// A pure orchestration over the trusted composition (buildPriorityDashboardsRelease) with every side-effecting
// step INJECTED, so it is fully offline-testable and the CLI wrapper only wires production collaborators +
// process.exit. It EXITS NONZERO on every derive/finalize/publish disposition except a proven success:
//   1. READ-ONLY reconciliation before any write (a mismatch stops before deriving);
//   2. derive US then Non-US through the composition (priority mode + the durable catalog guard enforce zero
//      OLI/Ads/FBA/other creates and at most one Catalog create / two tokens -- warm-cache-first spends ZERO;
//      the runner re-proves the durable reservation, when present, shows <= 2 tokens);
//   3. finalize each exact priority cycle through the corrected trusted verifier (finalizeBucket);
//   4. BEFORE the first live write, run the composition's SHARED read-only publisher preflight (the SAME
//      collaborators + gates as the real publish) for EVERY discovered account and all three keys; ANY
//      non-'ready' pair blocks ALL live writes (zero partial publish);
//   5. publish daily-reporting, brand-sales, brand-inventory (brand-sales before brand-inventory), accepting
//      ONLY 'published' or 'already-current', carrying each pair's EXACT live identity (liveReportKey + paramsHash);
//   6. read back each live snapshot by its EXACT identity (liveReportKey, account, paramsHash) and prove the
//      frontend payload contract.
// It NEVER applies a migration, NEVER enables the scheduler/cron, and NEVER touches unrelated reports/snapshots.

import { PRIORITY_DASHBOARDS } from "./source-priority-dashboards.js";

const OK_PUBLISH = new Set(["published", "already-current"]);
const OK_FINALIZE = new Set(["finalized", "already-terminal"]);
const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";

/**
 * Run the strict priority release. Returns { code, ok, stage, evidence, problems }: code 0 ONLY on a proven
 * full success; any other disposition yields code 1 with the stopping stage + typed problems (never a secret).
 *
 * deps:
 *   release            -- buildPriorityDashboardsRelease() instance (deriveBucket/finalizeBucket/preflightAccount/
 *                         publishAccount/catalogReservation/reportKeys/publishOrder).
 *   reconcile()        -> { ok, problems? }  READ-ONLY pre-write reconciliation.
 *   readbackLive({ reportKey, liveReportKey, accountId, paramsHash }) -> { ok, reason? }  EXACT-identity live
 *                         read-back (identity echoes, live version/params, nonblank refresh, storage-first
 *                         payload, real frontend payload contract).
 *   assertNoCron()     -> { ok, reason? }  proves no scheduler cron exists (never enables one).
 *   log(message)       -- optional progress line.
 */
export async function runPriorityDashboardsRelease(deps = {}) {
  const { release, reconcile, readbackLive, assertNoCron, log = () => {} } = deps;
  if (!release || typeof release.deriveBucket !== "function" || typeof release.finalizeBucket !== "function"
      || typeof release.preflightAccount !== "function" || typeof release.publishAccount !== "function") {
    throw new Error("runPriorityDashboardsRelease requires a release with deriveBucket/finalizeBucket/preflightAccount/publishAccount (fail closed).");
  }
  for (const [name, fn] of [["reconcile", reconcile], ["readbackLive", readbackLive], ["assertNoCron", assertNoCron]]) {
    if (typeof fn !== "function") throw new Error(`runPriorityDashboardsRelease requires ${name} (fail closed).`);
  }
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

  // (2b) the durable reservation, WHEN PRESENT, shows at most TWO tokens (a warm-cache-first release makes none).
  const reservation = await release.catalogReservation(null);
  const tokensSpent = reservation ? Number(reservation.tokensSpent) : 0;
  if (tokensSpent > PRIORITY_DASHBOARDS.maxTokens) return fail("token-ceiling", "reservation tokens_spent " + S(tokensSpent) + " > " + PRIORITY_DASHBOARDS.maxTokens);

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

  // (4) BEFORE any live write: the SHARED publisher preflight for EVERY account x 3 keys. ANY non-'ready' pair
  //     stops before publishing anything (no partial publish). Same collaborators + logic as the real publish.
  const gateProblems = [];
  for (const accountId of accountList) {
    const pf = await release.preflightAccount(accountId);
    for (const r of (pf && pf.results) || []) {
      if (S(r.disposition) !== "ready") gateProblems.push(r.reportKey + "/" + accountId + " -> " + S(r.disposition));
    }
  }
  if (gateProblems.length) return fail("publish-gates", gateProblems);
  log("publisher preflight proven ready for " + accountList.length + " accounts x " + PRIORITY_DASHBOARDS.reportKeys.length + " reports");

  // (5) publish daily-reporting, brand-sales, brand-inventory (order enforced by the composition); accept ONLY
  //     'published' / 'already-current'. Carry each pair's EXACT live identity for the read-back.
  const published = [];
  for (const accountId of accountList) {
    const res = await release.publishAccount(accountId);
    for (const r of (res && res.results) || []) {
      if (!OK_PUBLISH.has(S(r.disposition))) return fail("publish", r.reportKey + "/" + accountId + " -> " + S(r.disposition));
      if (!nb(r.liveReportKey) || !nb(r.paramsHash)) return fail("publish", r.reportKey + "/" + accountId + " missing live identity");
      published.push({ reportKey: r.reportKey, accountId, liveReportKey: S(r.liveReportKey), paramsHash: S(r.paramsHash), disposition: r.disposition });
    }
  }
  log("published " + published.length + " (report, account) pairs");

  // (6) read back the exact live identity for every published pair + prove the frontend payload contract.
  for (const p of published) {
    const rb = await readbackLive({ reportKey: p.reportKey, liveReportKey: p.liveReportKey, accountId: p.accountId, paramsHash: p.paramsHash });
    if (!rb || rb.ok !== true) return fail("readback", p.reportKey + "/" + p.accountId + " live read-back failed (" + S(rb && rb.reason) + ")");
  }

  // (7) still no cron; the runner never enabled one.
  const cron1 = await assertNoCron();
  if (!cron1 || cron1.ok !== true) return fail("assert-no-cron-final", (cron1 && cron1.reason) || "cron appeared");

  return { code: 0, ok: true, stage: "complete", evidence: { accounts: accountList.length, published: published.length, tokensSpent } };
}

/**
 * Build the EXACT-identity live read-back used by the runner (step 6). Every collaborator is injected so it is
 * offline-testable; the CLI wires the production readers. Given { reportKey, liveReportKey, accountId, paramsHash }
 * -- the exact live identity the publish produced -- it loads the live snapshot by that EXACT natural key and
 * proves: the live-report-key matches the contract; the row's params_hash echoes paramsHash; the stored params
 * carry the expected live version + account and RE-derive paramsHash (provenance -- a mutated-after-save row
 * fails); a nonblank refresh time; STORAGE-FIRST payload hydration; and the REAL frontend payload contract
 * (validatePayload true + not dataUnavailable). Returns { ok, reason? }.
 */
export function buildLiveReadback({ getReportSnapshot, loadStoragePayload, liveContracts, reportDerivations, computeHash } = {}) {
  for (const [name, fn] of [["getReportSnapshot", getReportSnapshot], ["loadStoragePayload", loadStoragePayload], ["computeHash", computeHash]]) {
    if (typeof fn !== "function") throw new Error(`buildLiveReadback requires ${name} (fail closed).`);
  }
  if (!liveContracts || !reportDerivations) throw new Error("buildLiveReadback requires liveContracts + reportDerivations (fail closed).");
  return async ({ reportKey, liveReportKey, accountId, paramsHash }) => {
    const contract = liveContracts[reportKey];
    if (!contract) return { ok: false, reason: "no-live-contract" };
    if (liveReportKey !== contract.liveReportKey) return { ok: false, reason: "live-report-key-mismatch" };
    if (!nb(paramsHash)) return { ok: false, reason: "blank-params-hash" };
    const snap = await getReportSnapshot({ reportKey: liveReportKey, accountId, paramsHash });
    if (!snap) return { ok: false, reason: "no-live-snapshot" };
    if (S(snap.params_hash) !== S(paramsHash)) return { ok: false, reason: "identity-hash" };
    const params = snap.params && typeof snap.params === "object" && !Array.isArray(snap.params) ? snap.params : null;
    if (!params || params.reportVersion !== contract.liveReportVersion) return { ok: false, reason: "live-version" };
    if (S(params.accountId) !== S(accountId)) return { ok: false, reason: "identity-account" };
    const liveParams = contract.liveParams(params);
    if (!liveParams || computeHash(contract.liveReportVersion, liveParams) !== paramsHash) return { ok: false, reason: "params-provenance" };
    if (!nb(snap.source_refreshed_at)) return { ok: false, reason: "blank-refresh" };
    let payload;
    const path = S(snap.payload_storage_path).trim();
    if (path) { try { payload = await loadStoragePayload(path); } catch { payload = null; } if (payload == null) return { ok: false, reason: "payload-dangling" }; }
    else { payload = snap.payload; if (payload == null) return { ok: false, reason: "payload-unavailable" }; }
    const entry = reportDerivations[reportKey];
    if (!entry || typeof entry.validatePayload !== "function" || entry.validatePayload(payload) !== true || (payload && payload.dataUnavailable === true)) return { ok: false, reason: "payload-contract" };
    return { ok: true };
  };
}
