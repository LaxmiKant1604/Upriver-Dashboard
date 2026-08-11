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
import { plannedSourceJob, reconcileStaleOwnerMemberships } from "./source-sync-driver.js";
import { keywordWeeklySignal } from "./source-signals.js";
import { planKeywordRank } from "./report-planner.js";
import { bucketForCountry } from "./registry.js";
import { classifyDirectoryAccounts } from "../datadoe-connections.js";
import { sourceJobOwnerId } from "../source-identity.js";

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
  // Primary-only safety: partition the directory against the CONFIGURED connections BEFORE any planning.
  // A stale `dd-secondary:` account (secondary org retired) is never planned, never routed to the primary
  // key, and its prefix/snapshots are untouched -- it is skipped read-only so it spends ZERO source jobs /
  // DataDoe calls and never fails the primary cycle.
  const { active, unavailable } = classifyDirectoryAccounts(accounts, connections);

  // Schedule-bucket isolation (Blocker 3): every active account's planner bucket MUST equal the supplied
  // cycle bucket, so one cycle can never mix US and non-US schedules or record an account in the
  // wrong bucket. Reject BEFORE opening a cycle or touching DataDoe -- a mixed-bucket input therefore
  // causes ZERO DataDoe calls (a caller must partition US/non-US into separate cycles).
  if (bucket !== "us" && bucket !== "non-us") {
    throw new Error(`runKeywordRankShadowCycle requires an explicit cycle bucket of 'us' or 'non-us' (got "${bucket}").`);
  }
  for (const a of active) {
    const accountBucket = bucketForCountry(a.country);
    if (accountBucket !== bucket) {
      throw new Error(`Keyword Rank cycle bucket "${bucket}" does not match account "${a.accountId}" (country "${a.country}" resolves to bucket "${accountBucket}"); refuse to mix schedule buckets in one cycle.`);
    }
  }

  const asOfOf = (a) => (typeof asOfFor === "function" ? asOfFor(a.country) : (a.asOf || asOf));
  // Per-account tracked state; each account owns its weekly/monthly canonical hashes (account-scoped).
  const state = active.map((a) => ({ account: a, asOf: asOfOf(a), weeklyHash: null, monthlyHash: null, weeklySignal: null, monthlySignal: null }));

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
      .map((s) => plannedSourceJob("keyword-rank", s, plan.bucket || bucket, DRIVER_CONNECTION_ID[plan.connectionId] || plan.connectionId, st.account.accountId));
  });

  // Owner memberships (sync_source_job_owners): each Keyword account+org is ONE owner (owner_id from
  // sourceJobOwnerId over report family + connection + org fingerprint + account scope). Every staged
  // source of that account is a membership under that owner_id. The declared owner set + planned
  // membership keys accumulate as rounds stage more sources; runSourceJobs processes only THIS cycle's
  // owned+planned canonical jobs, and OTHER report families sharing the (bucket, cycle_date) cycle are
  // never touched. A source an account no longer needs (e.g. monthly once weekly resolves >= 4) is
  // reconciled as a STALE owner membership at the end -- never by failing the shared canonical row.
  const ownerIdSet = new Set();

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
    for (const j of plannedJobs) ownerIdSet.add(j.owner.ownerId);
    const res = await runSourceJobs({ store, dataDoe, plannedJobs, ownerIds: [...ownerIdSet], bucket, cycleDate, scheduledAt, trigger, clock, deadlineMs, reserveMs, maxJobs: remaining });
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
  // Reconstruct each account's persisted weekly/monthly state ONE FINAL time BEFORE reading telemetry, so
  // rollup.perAccount is fresh even after a one-round (or deadline-truncated) invocation -- never stale.
  if (cycleId) await reconstruct(cycleId);

  // Blocker 1 -- reconcile stale owner memberships ONLY against each account's COMPLETE AUTHORITATIVE
  // resolved dependency set (planKeywordRank for the resolved cadence, which lists EVERY required source
  // including monthly/catalog even before they are staged), and ONLY for accounts whose cadence is
  // actually resolved this invocation (weekly a validated success). A bounded/maxRounds/deadline/deferred
  // invocation that has NOT resolved an account's cadence defers that account's reconciliation entirely,
  // so a still-required monthly/catalog membership from a prior invocation is never falsely retired. A
  // genuinely removed dependency (monthly once weekly resolves >= 4) is absent from the authoritative set
  // and correctly goes stale. This never touches the shared canonical row or another owner's membership.
  if (cycleId) {
    const authoritativeKeys = new Set();
    const reconcileOwnerIds = new Set();
    for (const st of state) {
      const w = st.weeklySignal;
      if (!w || w.status !== "success" || w.validated !== true) continue; // cadence unresolved -> defer
      const finalPlan = planKeywordRank({
        accountId: st.account.accountId, country: st.account.country, currency: st.account.currency,
        connections, asOf: st.asOf, weeklySignal: w,
      });
      const src0 = finalPlan.sources[0];
      if (!src0) continue;
      const ownerId = sourceJobOwnerId({
        reportKey: "keyword-rank",
        connectionId: DRIVER_CONNECTION_ID[finalPlan.connectionId] || finalPlan.connectionId,
        organizationFingerprint: src0.organizationFingerprint, accountScopeHash: src0.accountScopeHash,
      });
      if (!ownerId) continue;
      reconcileOwnerIds.add(ownerId);
      for (const s of finalPlan.sources) authoritativeKeys.add(`${ownerId}|${s.requestHash}`);
    }
    await reconcileStaleOwnerMemberships(store, cycleId, [...reconcileOwnerIds], authoritativeKeys);
  }
  rollup.perAccount = state.map((st) => ({
    accountId: st.account.accountId,
    connectionId: st.account.accountId.startsWith("dd-secondary:") ? "dd-secondary" : "primary",
    weeklyHash: st.weeklyHash,
    monthlyHash: st.monthlyHash,
    weeklySignal: st.weeklySignal,
    monthlySignal: st.monthlySignal,
  }));
  // Stale accounts whose owning connection is not configured: skipped read-only, zero jobs/calls spent.
  rollup.unavailableAccounts = unavailable;

  // Blocker 2 -- return the COMPLETE canonical report request per account (never filtered to
  // already-staged hashes). buildFinalReports lists EVERY source required for the account's currently
  // resolved cadence; a required dependency that has not yet been staged simply has no succeeded source
  // job, so the report FETCH GATE keeps the report PENDING (no derive, no failure, no snapshot) until a
  // later invocation stages + succeeds it -- then the SAME cycle derives and saves exactly once. Failed/
  // terminal weekly (or a failed required monthly) still yields the approved honest blocked outcome via
  // the gate. This prevents a checkpointed partial invocation (maxJobs/maxRounds/deadline) from exposing
  // a runnable-but-incomplete Keyword report that would derive-fail and freeze last-known-good.
  rollup.plannedReports = buildFinalReports({ state, connections, bucket });
  return rollup;
}

// Return the canonical keyword-rank report request per account for the account's currently resolved
// cadence: weekly + catalog always; + monthly when the weekly signal is a validated < 4 (fallback). Each
// source is REQUIRED and listed regardless of whether it has been staged yet, so the report fetch gate is
// pending until every required dependency has a succeeded job. Pure; no I/O, no DataDoe call.
function buildFinalReports({ state, connections, bucket }) {
  return state.map((st) => {
    const plan = planKeywordRank({
      accountId: st.account.accountId, country: st.account.country, currency: st.account.currency,
      connections, asOf: st.asOf, weeklySignal: st.weeklySignal,
    });
    // planKeywordRank already emits exactly the required set for the resolved cadence (weekly + catalog,
    // plus monthly iff the weekly signal makes the fallback apply), so no staged/persisted filtering.
    const sources = plan.sources.map((s) => ({ ...s, optional: false }));
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
