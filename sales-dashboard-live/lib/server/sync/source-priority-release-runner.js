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
import { buildLivePromotedResolver } from "./live-promoted-resolver.js";

const OK_PUBLISH = new Set(["published", "already-current"]);
const OK_FINALIZE = new Set(["finalized", "already-terminal"]);
const READY = new Set(["ready"]);
const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";

/**
 * Strictly validate a per-account result envelope ({ accountId, results }) from preflightAccount OR publishAccount
 * against the frozen three keys. Returns an array of typed problems (empty === valid). The SAME strictness is
 * applied to preflight and publish so a malformed / short / duplicated / extra / mis-echoed acknowledgement can
 * never be read as success: the account id must echo the request; results must be an array of EXACTLY the frozen
 * keys (unique -- no missing/extra/duplicate/unknown); each result must carry an accepted disposition, the exact
 * expected reportKey, and a nonblank live identity (liveReportKey + paramsHash).
 */
function threeResultProblems(frozenKeys, envelope, accountId, okDispositions) {
  if (!envelope || S(envelope.accountId) !== S(accountId)) return [accountId + " -> account echo mismatch (" + S(envelope && envelope.accountId) + ")"];
  const results = Array.isArray(envelope.results) ? envelope.results : null;
  if (!results) return [accountId + " -> results is not an array"];
  const frozenSet = new Set(frozenKeys);
  const keys = results.map((r) => S(r && r.reportKey));
  const uniq = new Set(keys);
  if (results.length !== frozenKeys.length || uniq.size !== frozenKeys.length || !frozenKeys.every((k) => uniq.has(k))) {
    return [accountId + " -> result set [" + keys.join(",") + "] != the frozen [" + frozenKeys.join(",") + "]"];
  }
  const problems = [];
  for (const r of results) {
    const rk = S(r && r.reportKey);
    if (!frozenSet.has(rk)) { problems.push(accountId + " -> unknown report key " + rk); continue; }
    if (!okDispositions.has(S(r.disposition))) { problems.push(rk + "/" + accountId + " -> " + S(r.disposition)); continue; }
    if (!nb(r && r.liveReportKey) || !nb(r && r.paramsHash)) problems.push(rk + "/" + accountId + " -> missing live identity");
  }
  return problems;
}

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
  // verifyLease (Round-8 blocker 1): an optional control-lease HEARTBEAT called immediately BEFORE each account's
  // publish. { ok:false } => the operation lost the lease -> STOP, publish nothing further, return typed
  // retryable contention (LKG preserved). Default null => no fencing (byte-identical natural behavior).
  const { release, reconcile, readbackLive, assertNoCron, verifyLease = null, log = () => {}, bucket = null, strictD1 = false } = deps;
  if (!release || typeof release.deriveBucket !== "function" || typeof release.finalizeBucket !== "function"
      || typeof release.preflightAccount !== "function" || typeof release.publishAccount !== "function") {
    throw new Error("runPriorityDashboardsRelease requires a release with deriveBucket/finalizeBucket/preflightAccount/publishAccount (fail closed).");
  }
  for (const [name, fn] of [["reconcile", reconcile], ["readbackLive", readbackLive], ["assertNoCron", assertNoCron]]) {
    if (typeof fn !== "function") throw new Error(`runPriorityDashboardsRelease requires ${name} (fail closed).`);
  }
  // INDEPENDENT per-bucket publish: when `bucket` is set, derive/finalize/publish EXACTLY that one bucket's
  // accounts and preserve the other bucket's snapshots byte-identically (nothing outside this bucket's discovered
  // scope is ever written). When `bucket` is null the runner publishes BOTH buckets together (the legacy combined
  // release). A bad bucket fails closed BEFORE any read.
  if (bucket != null && !PRIORITY_DASHBOARDS.buckets.includes(bucket)) {
    throw new Error(`runPriorityDashboardsRelease bucket must be one of ${PRIORITY_DASHBOARDS.buckets.join("|")} (got "${S(bucket)}") (fail closed).`);
  }
  const targetBuckets = bucket ? [bucket] : [...PRIORITY_DASHBOARDS.buckets];
  const fail = (stage, problems) => ({ code: 1, ok: false, stage, problems: Array.isArray(problems) ? problems : [S(problems)] });
  const effectiveByBucket = {};

  // (0) No scheduler cron may exist -- this runner never enables one.
  const cron0 = await assertNoCron();
  if (!cron0 || cron0.ok !== true) return fail("assert-no-cron", (cron0 && cron0.reason) || "cron present");

  // (1) READ-ONLY reconciliation BEFORE any write.
  const rec = await reconcile();
  if (!rec || rec.ok !== true) return fail("reconcile", (rec && rec.problems) || "reconciliation mismatch");
  log("reconcile ok");

  // (2) derive the target bucket(s). A skipped/stopped derive is a hard stop.
  for (const b of targetBuckets) {
    const { rollup } = await release.deriveBucket(b);
    if (!rollup || rollup.stopped === true || (rollup.derived && rollup.derived.skipped != null)) {
      // Thread the TYPED derive-stop code (rollup.stopReason.code) so callers classify retryable source/readiness
      // outcomes vs integrity failures WITHOUT text matching.
      const reason = S(rollup && ((rollup.stopReason && rollup.stopReason.code) || (rollup.derived && rollup.derived.skipped))) || null;
      return { ...fail("derive:" + b, "derive did not complete: " + reason), reason };
    }
    if (rollup.derived && rollup.derived.effectivePublishAsOf) effectiveByBucket[b] = S(rollup.derived.effectivePublishAsOf);
    // STRICT D-1: the derive was pinned to the requested D-1 (--as-of). If it nonetheless CLAMPED below D-1
    // (asOfClamped -- coverage regressed / a tail reappeared between the readiness proof and the derive), FAIL CLOSED
    // with a typed DATADOE_D1_NOT_READY; NEVER publish the clamped D-2 as D-1. LKG preserved (nothing published yet).
    if (strictD1 && rollup.derived && rollup.derived.asOfClamped === true) {
      return { code: 1, ok: false, stage: "d1-not-ready:" + b, status: "DATADOE_D1_NOT_READY", problems: ["DATADOE_D1_NOT_READY: derive clamped effectivePublishAsOf=" + S(rollup.derived.effectivePublishAsOf) + " below requestedAsOf=" + S(rollup.derived.refreshAsOf) + " for " + b + " -- LKG retained (no publish)."] };
    }
    // A derive that GATED on readiness (daily/brandView ready=false) produces NO snapshots -> NO lineage -> a
    // clean-looking rollup (skipped=null, stopped=false) with saved=0 and lineageCount=0. `!stopped && skipped==null`
    // is therefore NOT proof that report jobs were produced. Require the derive to have genuinely produced a
    // consistent, complete, LINEAGE-BACKED set BEFORE finalize/publication: both dashboards ready; every
    // dashboard saved > 0; the three per-account counts EQUAL (one daily + one brand-sales + one brand-inventory
    // per account -- no missing or duplicate job); and lineage matching that total. This fails the exact
    // ready=false / saved=0 / lineageCount=0 false-positive the runner used to log as "derive ok". The finalizer's
    // strict report-job-count assertion (against the discovered cycle scope, e.g. Non-US 22x3 / US 8x3) stays the
    // authoritative exact count and is left unchanged. An already-complete (short-circuited) cycle has no fresh
    // derive to re-verify -- its jobs already exist -- so it passes to the (unchanged) finalizer.
    if (rollup.alreadyComplete !== true) {
      const d = rollup.derived || {};
      const daily = d.daily || {}, bv = d.brandView || {}, inv = d.brandInventory || {};
      const ds = Number(daily.saved || 0), bs = Number(bv.saved || 0), is = Number(inv.saved || 0);
      const lineageCount = Array.isArray(d.lineage) ? d.lineage.length : 0;
      const problems = [];
      const blockerText = (arr) => (Array.isArray(arr) && arr.length ? " blockedBy=[" + arr.map((b) => S(b.sourceKey) + ":" + S(b.reason) + (b.accounts ? "x" + b.accounts : "")).join(", ") + "]" : "");
      const asOfText = " (refreshAsOf=" + S(d.refreshAsOf) + ", effectivePublishAsOf=" + S(d.effectivePublishAsOf) + (d.asOfClamped ? ", clamped" : "") + ")";
      // Collect STRUCTURED blocker codes (sourceKey:reason) from blockedBy so callers classify retryable readiness/
      // source blockers vs integrity blockers WITHOUT parsing formatted text; countMismatch is an integrity blocker code.
      const blockerCodes = [];
      const collect = (arr) => { for (const x of (Array.isArray(arr) ? arr : [])) blockerCodes.push(S(x && x.sourceKey) + ":" + S(x && x.reason)); };
      if (daily.ready !== true) { problems.push("daily-reporting not ready (ready=" + S(daily.ready) + ")" + blockerText(daily.blockedBy) + asOfText); collect(daily.blockedBy); }
      if (bv.ready !== true) { problems.push("brand-sales not ready (ready=" + S(bv.ready) + ")" + blockerText(bv.blockedBy) + asOfText); collect(bv.blockedBy); }
      if (ds <= 0 || bs <= 0 || is <= 0) { problems.push("saved report jobs = 0 (daily=" + ds + ", brand-sales=" + bs + ", brand-inventory=" + is + ")"); if (daily.ready === true && bv.ready === true) blockerCodes.push("derive:saved-zero"); }
      else if (ds !== bs || bs !== is) { problems.push("inconsistent per-account counts (daily=" + ds + ", brand-sales=" + bs + ", brand-inventory=" + is + ") -- a missing or duplicate report job"); blockerCodes.push("derive:count-mismatch"); }
      if (lineageCount !== ds + bs + is) { problems.push("lineage " + lineageCount + " != saved " + (ds + bs + is)); blockerCodes.push("derive:lineage-mismatch"); }
      if (problems.length) return { ...fail("derive:" + b, ["derive produced no validated report jobs for " + b + " (a ready=false/saved=0 derive is NOT 'derive ok'): " + problems.join("; ")]), reason: blockerCodes[0] || "derive-not-ready", blockerCodes };
      log("derive ok: " + b + " (" + ds + " x 3 = " + (ds * 3) + " report jobs, lineage " + lineageCount + ", effectivePublishAsOf=" + S(d.effectivePublishAsOf) + (d.asOfClamped ? " CLAMPED from " + S(d.refreshAsOf) : "") + ")");
    } else {
      log("derive ok: " + b + " (already-complete cycle; jobs pre-exist -- finalizer re-verifies the exact count)");
    }
  }

  // (2b) the durable reservation, WHEN PRESENT, shows at most TWO tokens (a warm-cache-first release makes none).
  const reservation = await release.catalogReservation(null);
  const tokensSpent = reservation ? Number(reservation.tokensSpent) : 0;
  if (tokensSpent > PRIORITY_DASHBOARDS.maxTokens) return fail("token-ceiling", "reservation tokens_spent " + S(tokensSpent) + " > " + PRIORITY_DASHBOARDS.maxTokens);

  // (3) finalize each targeted priority cycle; collect the proven account scope (this bucket's accounts only)
  //     AND the ACTUAL durable cycle id per account (Round-7 blocker 2 provenance: the publication manifest
  //     records this real sync_cycles id, never a bucket label).
  const accounts = new Set();
  const cycleIdByAccount = new Map();
  for (const b of targetBuckets) {
    const fin = await release.finalizeBucket(b);
    if (!fin || !OK_FINALIZE.has(S(fin.disposition))) { const reason = S(fin && (fin.reason || fin.disposition)) || null; return { ...fail("finalize:" + b, "finalize refused: " + reason), reason }; }
    for (const a of fin.accounts || []) { accounts.add(S(a)); cycleIdByAccount.set(S(a), S(fin.cycleId)); }
    log("finalize ok: " + b + " (" + (fin.accounts ? fin.accounts.length : 0) + " accounts, " + S(fin.cycleStatus) + ", cycle " + S(fin.cycleId).slice(0, 8) + ")");
  }
  const accountList = [...accounts].sort();
  if (!accountList.length) return fail("scope", "no proven accounts to publish");

  // (4) BEFORE any live write: the SHARED publisher preflight for EVERY account x 3 keys. The result SHAPE is
  //     verified strictly (the account id echoes; EXACTLY the frozen three keys, unique, no missing/extra/dup;
  //     each disposition=ready with a nonblank live identity). ANY violation stops before publishing anything
  //     (no partial publish). Same collaborators + logic as the real publish.
  const FROZEN = PRIORITY_DASHBOARDS.reportKeys;
  const gateProblems = [];
  for (const accountId of accountList) {
    const pf = await release.preflightAccount(accountId);
    gateProblems.push(...threeResultProblems(FROZEN, pf, accountId, READY));
  }
  if (gateProblems.length) return fail("publish-gates", gateProblems);
  log("publisher preflight proven ready for " + accountList.length + " accounts x " + FROZEN.length + " reports");

  // (5) publish daily-reporting, brand-sales, brand-inventory (order enforced by the composition). The publish
  //     acknowledgement is validated with the SAME strictness as the preflight: the account echoes, EXACTLY the
  //     frozen three keys (unique -- no missing/extra/duplicate/unknown/malformed/non-array), each with an
  //     accepted disposition ('published' / 'already-current') AND a nonblank live identity. Any violation stops
  //     BEFORE the read-back (never a partial / false success -- e.g. results=[] can NEVER return code 0).
  const published = [];
  for (const accountId of accountList) {
    // FENCING (blocker 1): renew + prove we still own the unexpired control lease IMMEDIATELY before publishing
    // this account. If lost (expired/reclaimed/taken over), STOP -- publish nothing further (LKG preserved).
    if (typeof verifyLease === "function") {
      let fence;
      try { fence = await verifyLease(); } catch (e) { fence = { ok: false, reason: "renew-threw:" + S(e && e.message ? e.message : e) }; }
      if (!fence || fence.ok !== true) {
        return { code: 1, ok: false, stage: "contention", status: "CONTROL_LEASE_LOST", leaseLost: true,
          problems: ["CONTROL_LEASE_LOST: the control-plane lease was lost mid-publish (" + S(fence && fence.reason) + ") after " + published.length + " publications -- stopping; LKG preserved; retryable."] };
      }
    }
    const res = await release.publishAccount(accountId);
    // WRITE-BOUNDARY FENCING (Round-9 P0-A, property 7): EACH report write fences the control fence inside the
    // report_snapshots CAS. A 'lease-lost' disposition means the write wrote ZERO rows (lease superseded/expired/
    // reclaimed) -- STOP with typed retryable contention, never a hard publish failure (LKG preserved).
    if (Array.isArray(res && res.results) && res.results.some((r) => r && r.disposition === "lease-lost")) {
      return { code: 1, ok: false, stage: "contention", status: "CONTROL_LEASE_LOST", leaseLost: true,
        problems: ["CONTROL_LEASE_LOST: a report write for " + accountId + " lost the control-plane fence at the write boundary after " + published.length + " publications -- stopping; LKG preserved; retryable."] };
    }
    // A 'newer-live' disposition is a BENIGN freshness outcome, never a publish FAILURE: the report_snapshots CAS found
    // the LIVE row STRICTLY NEWER than this (older) candidate and preserved it (LKG kept, ZERO overwrite) -- e.g. a
    // brand-inventory live maintained by the scheduler's materialize-inventory job with a fresher source_refreshed_at.
    // The account's report is already AT LEAST as fresh as what we derived; overwriting it would be a regression the CAS
    // correctly refuses. Defer this account (retryable; retain the newer live), consistent with EVERY shadow-save path
    // (daily-reporting / fba-brand-inventory / listing-health-v3 all `defer("shadow-newer-live")`). This runner is used
    // ONLY by the per-account reconciler + bootstrap (never the high-volume scheduler publish), so the return defers just
    // this account; the read-back below is skipped for it (nothing was written). NEVER a hard FAILED_PUBLISH.
    if (Array.isArray(res && res.results) && res.results.some((r) => r && r.disposition === "newer-live")) {
      const keys = res.results.filter((r) => r && r.disposition === "newer-live").map((r) => S(r.reportKey)).join(",");
      return { code: 1, ok: false, stage: "publish", status: "NEWER_LIVE", reason: "publish-newer-live",
        problems: ["a strictly-newer live row exists for " + accountId + " [" + keys + "] (CAS newer-live; LKG preserved, zero overwrite) -- deferring this account; its report is already at least as fresh as the derived candidate; retryable."] };
    }
    const probs = threeResultProblems(FROZEN, res, accountId, OK_PUBLISH);
    if (probs.length) return fail("publish", probs);
    for (const r of res.results) published.push({ reportKey: S(r.reportKey), accountId, liveReportKey: S(r.liveReportKey), paramsHash: S(r.paramsHash), disposition: r.disposition });
  }
  // The explicit count pin: EXACTLY three proven publications per proven account, never fewer.
  const expectedPublications = accountList.length * FROZEN.length;
  if (published.length !== expectedPublications) return fail("publish", "published " + published.length + " != expected " + expectedPublications + " (accounts " + accountList.length + " x " + FROZEN.length + ")");
  log("published " + published.length + " (report, account) pairs");

  // (6) read back the exact live identity for every published pair + prove the frontend payload contract.
  for (const p of published) {
    const rb = await readbackLive({ reportKey: p.reportKey, liveReportKey: p.liveReportKey, accountId: p.accountId, paramsHash: p.paramsHash });
    if (!rb || rb.ok !== true) return fail("readback", p.reportKey + "/" + p.accountId + " live read-back failed (" + S(rb && rb.reason) + ")");
  }

  // (7) still no cron; the runner never enabled one.
  const cron1 = await assertNoCron();
  if (!cron1 || cron1.ok !== true) return fail("assert-no-cron-final", (cron1 && cron1.reason) || "cron appeared");

  return {
    code: 0, ok: true, stage: "complete",
    evidence: { bucket: bucket || "both", accounts: accountList.length, published: published.length, tokensSpent, effectivePublishAsOf: effectiveByBucket },
    // The EXACT live identities this release produced (Round-6 blocker 7 manifest) + the ACTUAL durable cycle
    // id that produced each (Round-7 blocker 2 provenance): [{ reportKey, accountId, liveReportKey, paramsHash,
    // cycleId }]. Additive -- the natural path ignores it.
    publishedIdentities: published.map((p) => ({ reportKey: p.reportKey, accountId: p.accountId, liveReportKey: p.liveReportKey, paramsHash: p.paramsHash, cycleId: S(cycleIdByAccount.get(p.accountId)) })),
  };
}

/**
 * Build the EXACT-identity live read-back used by the runner (step 6). Every collaborator is injected so it is
 * offline-testable; the CLI wires the production readers. Given { reportKey, liveReportKey, accountId, paramsHash,
 * signal? } -- the exact live identity the publish produced, plus an OPTIONAL AbortSignal threaded to the live read +
 * storage hydration (omit it for byte-for-byte legacy behaviour) -- it loads the live snapshot by that EXACT key and
 * proves: the live-report-key matches the contract; the ROW's report_key + account_id echo the requested
 * identity (the published live params do NOT carry accountId -- identity comes from the row columns); the row's
 * params_hash echoes paramsHash; the stored params carry the expected live version + contract-derived live
 * params and RE-derive paramsHash (provenance -- a mutated-after-save row fails); a nonblank refresh time;
 * STORAGE-FIRST payload hydration; and the REAL frontend payload contract (validatePayload true + not
 * dataUnavailable). Returns { ok, reason? }.
 */
export function buildLiveReadback(deps = {}) {
  // Round-WORK-C/D: the proof body is now the SHARED buildLivePromotedResolver (live-promoted-resolver.js), used
  // ALSO by the strict serve resolver. buildLiveReadback is a thin wrapper that DROPS the hydrated payload, so the
  // reconciler read-back's { ok, reason } shape + every check is byte-for-byte unchanged (the optional `signal` still
  // threads to the read + hydration; callers that pass none default it to null exactly as before).
  const resolve = buildLivePromotedResolver(deps);
  return async ({ reportKey, liveReportKey, accountId, paramsHash, signal = null }) => {
    const r = await resolve({ reportKey, liveReportKey, accountId, paramsHash, signal });
    return r && r.ok === true ? { ok: true } : { ok: false, reason: r ? r.reason : "resolver-null" };
  };
}
