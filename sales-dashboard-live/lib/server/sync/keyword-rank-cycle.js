// Scheduler v2 -- account-scoped STAGED orchestration for Keyword Rank (SHADOW MODE).
//
// Blocker 1: the generic staged driver keys signals by requestKey, which is UNSAFE for a cycle with
// multiple accounts (one account's weekly period count could gate another's fallback). This driver
// replans EACH account from ITS OWN persisted weekly/monthly outcome, keyed by that account's canonical
// request HASH -- never a global request-key signal. Primary and dd-secondary accounts with the same raw
// id resolve DIFFERENT hashes (different org fingerprints), so they can never consume each other's signal.
//
// It reuses the approved pure worker (runSourceJobs, which enforces one-create-export-per-request-hash-
// per-cycle) and the approved plannedSourceJob; a fresh invocation reconstructs the same account-scoped
// signals from persisted jobs + saved cache WITHOUT repeating any export. Blocker 2 (staged catalog) is
// enforced by planKeywordRank, which spends no catalog token until a validated weekly(>=4)/monthly.
//
// SHADOW MODE: not wired to any cron/route; Keyword Rank stays locked. Injected store + dataDoe make it
// deterministic and offline-testable; it makes no DataDoe call itself.

import { runSourceJobs } from "./source-worker.js";
import { plannedSourceJob } from "./source-sync-driver.js";
import { keywordWeeklySignal } from "./source-signals.js";
import { planKeywordRank } from "./report-planner.js";

// The planner/organization-registry connection id ("primary" | "secondary") -> the source driver's
// fail-closed connection id ("primary" | "dd-secondary") that plannedSourceJob validates.
const DRIVER_CONNECTION_ID = { primary: "primary", secondary: "dd-secondary" };

// Typed monthly-success signal for the staged catalog gate: only a persisted monthly job that SUCCEEDED
// with a cleanly-loaded array is a validated success; anything else activates no catalog.
function monthlySuccessSignal(loadedRows) {
  return loadedRows === null ? { status: "failed", validated: false } : { status: "success", validated: true };
}

/**
 * Run the Keyword Rank staged source cycle for a set of accounts, account-scoped by request hash.
 * `accounts`: [{ accountId, country, currency }]; `asOfFor(country)` (or per-account `asOf`, or a single
 * `asOf`) supplies the marketplace-local as-of date. Rounds:
 *   R1: SQP-weekly only (per account).
 *   R2: from each account's reconstructed weekly signal -> monthly (weekly<4) OR catalog (weekly>=4).
 *   R3: from each account's reconstructed monthly signal -> catalog (weekly<4 accounts, incl. baseline).
 * Idempotent: a repeated/fresh call re-derives from persisted state and creates NO duplicate exports.
 * Returns a rollup with per-account hashes/signals so a caller/test can assert isolation + token spend.
 */
export async function runKeywordRankShadowCycle({
  accounts = [], connections, asOf = null, asOfFor = null, store, dataDoe,
  bucket, cycleDate, scheduledAt = null, trigger = "manual",
  clock = () => Date.now(), deadlineMs = Infinity, reserveMs = 3_000, maxJobs = Infinity, maxRounds = 3,
}) {
  const asOfOf = (a) => (typeof asOfFor === "function" ? asOfFor(a.country) : (a.asOf || asOf));
  // Per-account tracked state; each account owns its weekly/monthly canonical hashes (account-scoped).
  const state = accounts.map((a) => ({ account: a, asOf: asOfOf(a), weeklyHash: null, monthlyHash: null, weeklySignal: null, monthlySignal: null }));

  const loadRows = async (hash) => {
    if (!hash || !store.loadSourceRows) return null;
    try { const p = await store.loadSourceRows(hash); return p && Array.isArray(p.rows) ? p.rows : null; } catch (_e) { return null; }
  };

  // Reconstruct each account's typed signals from ITS OWN persisted jobs (by hash) + saved cache.
  const reconstruct = async (cycleId) => {
    const jobs = await store.listSourceJobs(cycleId);
    const byHash = new Map(jobs.map((j) => [j.request_hash ?? j.requestHash, j]));
    const succeeded = (hash) => { const j = byHash.get(hash); return !!j && (j.fetch_status ?? j.fetchStatus) === "succeeded"; };
    for (const st of state) {
      if (st.weeklyHash) {
        if (succeeded(st.weeklyHash)) {
          const rows = await loadRows(st.weeklyHash);
          // A cleanly-loaded array (even []) is a validated weekly success; a missing/unreadable cache
          // is NOT (it must not activate downstream).
          st.weeklySignal = rows === null
            ? { status: "failed", validated: false, distinctPeriods: null }
            : keywordWeeklySignal({ status: "success", validated: true, rows });
        } else {
          const j = byHash.get(st.weeklyHash);
          st.weeklySignal = j ? { status: j.terminal ? "terminal" : "failed", validated: false, distinctPeriods: null } : null;
        }
      }
      if (st.monthlyHash) {
        st.monthlySignal = succeeded(st.monthlyHash)
          ? monthlySuccessSignal(await loadRows(st.monthlyHash))
          : { status: "failed", validated: false };
      }
    }
  };

  // Plan the current round for every account from its OWN weekly signal; record its canonical hashes.
  const planRound = () => state.map((st) => {
    const plan = planKeywordRank({
      accountId: st.account.accountId, country: st.account.country, currency: st.account.currency,
      connections, asOf: st.asOf, weeklySignal: st.weeklySignal,
    });
    const wk = plan.sources.find((s) => s.requestKey === "keyword-rank:sqp-weekly");
    if (wk) st.weeklyHash = wk.requestHash;
    const mo = plan.sources.find((s) => s.requestKey === "keyword-rank:sqp-monthly");
    if (mo) st.monthlyHash = mo.requestHash;
    return { st, plan };
  });

  // Blocker 2 -- which of an account's resolved sources are EXECUTED this round (the catalog contract
  // is unconditional, so the DRIVER stages its export): weekly in R1; then monthly (weekly < 4) OR
  // catalog (weekly >= 4) in R2; then catalog (weekly < 4 + validated monthly) in R3. A failed/disabled/
  // unvalidated weekly OR required monthly spends NO catalog token.
  const submitKeys = (st, round) => {
    if (round === 0) return new Set(["keyword-rank:sqp-weekly"]);
    const w = st.weeklySignal;
    const weeklyValidated = !!w && w.status === "success" && w.validated === true;
    const weeklyHigh = weeklyValidated && Number(w.distinctPeriods) >= 4;
    const weeklyLow = weeklyValidated && Number(w.distinctPeriods) < 4;
    if (round === 1) {
      if (weeklyHigh) return new Set(["keyword-rank:catalog"]);
      if (weeklyLow) return new Set(["keyword-rank:sqp-monthly"]);
      return new Set();
    }
    const m = st.monthlySignal;
    const monthlyValidated = !!m && m.status === "success" && m.validated === true;
    if (weeklyLow && monthlyValidated) return new Set(["keyword-rank:catalog"]);
    return new Set();
  };

  const jobsOf = (planned, round) => planned.flatMap(({ st, plan }) => {
    const keys = submitKeys(st, round);
    return plan.sources
      .filter((s) => keys.has(s.requestKey))
      .map((s) => plannedSourceJob("keyword-rank", s, plan.bucket || bucket, DRIVER_CONNECTION_ID[plan.connectionId] || plan.connectionId));
  });

  const rollup = { cycleId: null, rounds: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0 };
  let cycleId = null;
  for (let round = 0; round < maxRounds; round += 1) {
    if (round > 0) await reconstruct(cycleId);
    const planned = planRound();
    const plannedJobs = jobsOf(planned, round);
    const res = await runSourceJobs({ store, dataDoe, plannedJobs, bucket, cycleDate, scheduledAt, trigger, clock, deadlineMs, reserveMs, maxJobs });
    cycleId = res.cycleId;
    rollup.cycleId = cycleId;
    rollup.rounds = round + 1;
    rollup.processed += res.processed;
    rollup.succeeded += res.succeeded;
    rollup.failed += res.failed;
    rollup.skipped += res.skipped;
  }
  rollup.perAccount = state.map((st) => ({
    accountId: st.account.accountId,
    connectionId: st.account.accountId.startsWith("dd-secondary:") ? "dd-secondary" : "primary",
    weeklyHash: st.weeklyHash,
    monthlyHash: st.monthlyHash,
    weeklySignal: st.weeklySignal,
    monthlySignal: st.monthlySignal,
  }));
  return rollup;
}
