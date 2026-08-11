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
import { bucketForCountry } from "./registry.js";

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
  // Schedule-bucket isolation (Blocker 3): every account's planner bucket MUST equal the supplied
  // cycle bucket, so one cycle can never mix US and non-US schedules or record an account in the
  // wrong bucket. Reject BEFORE opening a cycle or touching DataDoe -- a mixed-bucket input therefore
  // causes ZERO DataDoe calls (a caller must partition US/non-US into separate cycles).
  if (bucket !== "us" && bucket !== "non-us") {
    throw new Error(`runKeywordRankShadowCycle requires an explicit cycle bucket of 'us' or 'non-us' (got "${bucket}").`);
  }
  for (const a of accounts) {
    const accountBucket = bucketForCountry(a.country);
    if (accountBucket !== bucket) {
      throw new Error(`Keyword Rank cycle bucket "${bucket}" does not match account "${a.accountId}" (country "${a.country}" resolves to bucket "${accountBucket}"); refuse to mix schedule buckets in one cycle.`);
    }
  }

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

  // Blocker 1 (shared-cycle ownership) -- the COMPLETE set of source jobs this cycle owns for these
  // accounts: weekly + catalog + monthly for EVERY account, independent of which round stages each. The
  // monthly window is forced here (distinctPeriods:0 => the fallback applies) purely to enumerate the
  // canonical monthly hash; request hashes are signal-independent, so this is exactly the hash real
  // staging produces. Passed as the worker's TYPED ownership scope so the shared (bucket, cycle_date)
  // cycle's OTHER report families are never touched, while a keyword job staged in a prior round/
  // invocation is merged + resumed here (never MISSING_PLAN'd). A genuine keyword orphan (a stale hash
  // with a keyword request_key) still fails closed.
  const FORCE_MONTHLY_SIGNAL = { status: "success", validated: true, distinctPeriods: 0 };
  const ownedJobs = state.flatMap((st) => {
    const full = planKeywordRank({
      accountId: st.account.accountId, country: st.account.country, currency: st.account.currency,
      connections, asOf: st.asOf, weeklySignal: FORCE_MONTHLY_SIGNAL,
    });
    return full.sources.map((s) => plannedSourceJob("keyword-rank", s, full.bucket || bucket, DRIVER_CONNECTION_ID[full.connectionId] || full.connectionId));
  });

  const rollup = { cycleId: null, rounds: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0, deferred: 0, deadlineReached: false, drained: false };
  let cycleId = null;
  for (let round = 0; round < maxRounds; round += 1) {
    // Blocker 3 -- per-invocation bounds are CUMULATIVE across every staged round (never reset per
    // round): maxJobs caps the total source jobs processed by THIS invocation, and the deadline/
    // reserve budget covers the WHOLE invocation. Once the budget is spent, do NOT open a later
    // monthly/catalog round -- a fresh invocation resumes from persisted state without a duplicate POST.
    const remaining = maxJobs === Infinity ? Infinity : Math.max(0, maxJobs - rollup.processed);
    if (remaining === 0) { rollup.drained = false; break; }
    if (round > 0) await reconstruct(cycleId);
    const planned = planRound();
    const plannedJobs = jobsOf(planned, round);
    const res = await runSourceJobs({ store, dataDoe, plannedJobs, ownedJobs, bucket, cycleDate, scheduledAt, trigger, clock, deadlineMs, reserveMs, maxJobs: remaining });
    cycleId = res.cycleId;
    rollup.cycleId = cycleId;
    rollup.rounds = round + 1;
    rollup.processed += res.processed;
    rollup.succeeded += res.succeeded;
    rollup.failed += res.failed;
    rollup.skipped += res.skipped;
    rollup.deferred += res.deferred || 0;
    rollup.drained = res.drained;
    // Stop IMMEDIATELY on a wall-clock deadline or a resumable deferral: the invocation's budget is
    // exhausted, so no later monthly/catalog round starts. (A deadline during the weekly poll thus
    // prevents monthly/catalog work; the next fresh invocation resumes the export + later stages.)
    if (res.deadlineReached) { rollup.deadlineReached = true; rollup.drained = false; break; }
    if ((res.deferred || 0) > 0) { rollup.drained = false; break; }
  }
  rollup.perAccount = state.map((st) => ({
    accountId: st.account.accountId,
    connectionId: st.account.accountId.startsWith("dd-secondary:") ? "dd-secondary" : "primary",
    weeklyHash: st.weeklyHash,
    monthlyHash: st.monthlyHash,
    weeklySignal: st.weeklySignal,
    monthlySignal: st.monthlySignal,
  }));

  // Blocker 4 -- reconstruct each account's persisted weekly/monthly state ONE FINAL time and return
  // the canonical per-account report requests (plannedReports) for runReportJobs. Each report depends
  // ONLY on the sources actually STAGED this cycle (matched by canonical request hash to the persisted
  // jobs), so the final depends_on is exact: a successful weekly account depends on weekly + catalog; a
  // successful fallback account on weekly + monthly + catalog. The catalog token is NEVER fabricated --
  // a failed/disabled weekly or a failed required monthly staged no catalog, so the report neither
  // lists nor waits forever on it and instead resolves to an honest blocked state via the fetch gate.
  // Every staged source is REQUIRED (weekly always; catalog once the cadence resolved; monthly when
  // weekly < 4, where it is genuinely required), so a failed staged dependency blocks honestly.
  if (cycleId) await reconstruct(cycleId); // reconstruct persisted weekly/monthly state one final time
  rollup.plannedReports = await buildFinalReports({ state, cycleId, store, connections, bucket });
  return rollup;
}

// Reconstruct each account's final typed signals from persisted state, then return the canonical
// keyword-rank report request per account whose `sources` are EXACTLY the ones staged this cycle
// (filtered by persisted request hash), each marked required, with the connection normalized to the
// driver id. Pure aside from the injected store reads; makes no DataDoe call.
async function buildFinalReports({ state, cycleId, store, connections, bucket }) {
  if (!cycleId) return [];
  const jobs = await store.listSourceJobs(cycleId);
  const persisted = new Set(jobs.map((j) => j.request_hash ?? j.requestHash));
  return state.map((st) => {
    const plan = planKeywordRank({
      accountId: st.account.accountId, country: st.account.country, currency: st.account.currency,
      connections, asOf: st.asOf, weeklySignal: st.weeklySignal,
    });
    const sources = plan.sources
      .filter((s) => persisted.has(s.requestHash))
      .map((s) => ({ ...s, optional: false }));
    return {
      reportKey: "keyword-rank",
      reportVersion: plan.reportVersion,
      accountId: plan.accountId,
      connectionId: DRIVER_CONNECTION_ID[plan.connectionId] || plan.connectionId,
      bucket: plan.bucket || bucket,
      sources,
      context: plan.context,
    };
  });
}
