// Scheduler v2 -- account-scoped STAGED orchestration for Listing & Search Optimizer (SHADOW MODE).
//
// Listing Optimizer is a two-stage source flow:
//   R1: the SQP-weekly KICKOFF export only (per account) -- the ONLY token the kickoff spends.
//   R2: from each account's reconstructed SQP signal -> the rich content catalog, but ONLY when the SQP
//       job is a validated success (a cleanly-loaded array, INCLUDING a genuine zero-row success). A
//       disabled / failed / unvalidated / missing SQP spends ZERO catalog exports (the derive then produces
//       the honest sqpAvailable:false snapshot or preserves last-known-good).
//
// Like the other staged cycles this replans EACH account from ITS OWN persisted SQP outcome, keyed by that
// account's canonical request HASH -- never a global request-key signal. Primary and dd-secondary accounts
// with the same raw id resolve DIFFERENT hashes (different org fingerprints) and can never consume each
// other's signal. It reuses the approved pure worker (runSourceJobs: one create-export per request_hash per
// cycle) + plannedSourceJob; a fresh invocation reconstructs the same account-scoped signal from persisted
// jobs + saved cache WITHOUT repeating any export (idempotent). SHADOW MODE: not wired to any cron/route;
// Listing Optimizer stays locked. Injected store + dataDoe make it deterministic and offline-testable; it
// makes no DataDoe call itself.

import { runSourceJobs } from "./source-worker.js";
import { plannedSourceJob, reconcileStaleOwnerMemberships } from "./source-sync-driver.js";
import { planListingOptimizer } from "./report-planner.js";
import { bucketForCountry } from "./registry.js";
import { classifyDirectoryAccounts } from "../datadoe-connections.js";
import { sourceJobOwnerId } from "../source-identity.js";

// The planner/organization-registry connection id ("primary" | "secondary") -> the source driver's
// fail-closed connection id ("primary" | "dd-secondary") that plannedSourceJob validates.
const DRIVER_CONNECTION_ID = { primary: "primary", secondary: "dd-secondary" };

// Typed SQP-success signal for the staged catalog gate: a persisted SQP job that SUCCEEDED with a cleanly
// loaded array (even []) is a VALIDATED success (activates the catalog); a missing/unreadable cache is NOT.
function sqpSuccessSignal(loadedRows) {
  return loadedRows === null ? { status: "failed", validated: false } : { status: "success", validated: true };
}

/**
 * Run the Listing Optimizer staged source cycle for a set of accounts, account-scoped by request hash.
 * `accounts`: [{ accountId, country, currency }]; `asOfFor(country)` (or per-account `asOf`, or a single
 * `asOf`) supplies the marketplace-local as-of date. Rounds: R1 SQP-weekly only; R2 catalog ONLY for
 * accounts whose SQP is a validated success. Idempotent: a repeated/fresh call re-derives from persisted
 * state and creates NO duplicate exports. Returns a rollup with per-account SQP hash/signal (isolation +
 * token spend are assertable) and the final plannedReports for runReportJobs.
 */
export async function runListingOptimizerShadowCycle({
  accounts = [], connections, asOf = null, asOfFor = null, store, dataDoe,
  bucket, cycleDate, scheduledAt = null, trigger = "manual",
  clock = () => Date.now(), deadlineMs = Infinity, reserveMs = 3_000, maxJobs = Infinity, maxRounds = 2,
  sourceTranche = null, // BUILD-TIME source-tranche selector (Part A); passed through to runSourceJobs.
  reuseOnly = false,    // BUILD-TIME reuseOnly rehearsal flag (Blocker 3); passed through to runSourceJobs.
}) {
  // Primary-only safety: partition the directory against the CONFIGURED connections BEFORE any planning. A
  // stale `dd-secondary:` account (secondary org retired) is never planned, never routed to the primary key,
  // and its prefix/snapshots are untouched -- skipped read-only, spending ZERO source jobs / DataDoe calls.
  const { active, unavailable } = classifyDirectoryAccounts(accounts, connections);

  // Schedule-bucket isolation: every active account's planner bucket MUST equal the supplied cycle bucket,
  // rejected BEFORE opening a cycle or touching DataDoe (a mixed-bucket input causes ZERO DataDoe calls).
  if (bucket !== "us" && bucket !== "non-us") {
    throw new Error(`runListingOptimizerShadowCycle requires an explicit cycle bucket of 'us' or 'non-us' (got "${bucket}").`);
  }
  for (const a of active) {
    const accountBucket = bucketForCountry(a.country);
    if (accountBucket !== bucket) {
      throw new Error(`Listing Optimizer cycle bucket "${bucket}" does not match account "${a.accountId}" (country "${a.country}" resolves to bucket "${accountBucket}"); refuse to mix schedule buckets in one cycle.`);
    }
  }

  const asOfOf = (a) => (typeof asOfFor === "function" ? asOfFor(a.country) : (a.asOf || asOf));
  // Per-account tracked state; each account owns its SQP + catalog canonical hashes (account-scoped) and the
  // RAW fetch_status of each (null when the job does not exist yet). The raw statuses drive the state-aware
  // final dependency flags in buildFinalReports (a source stays REQUIRED -> the report fetch gate keeps the
  // report PENDING -- while its job is unstaged/pending/in-flight; it becomes OPTIONAL only once its job has
  // terminally RESOLVED to a non-success the derive must interpret).
  const state = active.map((a) => ({
    account: a, asOf: asOfOf(a),
    sqpHash: null, sqpSignal: null, sqpJobStatus: null,
    catalogHash: null, catalogJobStatus: null,
  }));

  const loadRows = async (hash) => {
    if (!hash || !store.loadSourceRows) return null;
    try { const p = await store.loadSourceRows(hash); return p && Array.isArray(p.rows) ? p.rows : null; } catch (_e) { return null; }
  };

  // Reconstruct each account's typed SQP signal + the RAW fetch_status of its SQP + catalog jobs, from ITS
  // OWN persisted jobs (by hash) + saved cache.
  const reconstruct = async (cycleId) => {
    const jobs = await store.listSourceJobs(cycleId);
    const byHash = new Map(jobs.map((j) => [j.request_hash ?? j.requestHash, j]));
    for (const st of state) {
      if (st.sqpHash) {
        const j = byHash.get(st.sqpHash);
        st.sqpJobStatus = j ? (j.fetch_status ?? j.fetchStatus ?? null) : null;
        const succeeded = !!j && st.sqpJobStatus === "succeeded";
        if (succeeded) {
          // A cleanly-loaded array (even []) is a validated SQP success; a missing/unreadable cache is NOT.
          st.sqpSignal = sqpSuccessSignal(await loadRows(st.sqpHash));
        } else {
          st.sqpSignal = j ? { status: j.terminal ? "terminal" : "failed", validated: false } : null;
        }
      }
      // The catalog job exists only after a validated SQP success staged it; its raw status decides whether
      // an unstaged/in-flight catalog keeps the report PENDING (required) or a resolved-failed catalog
      // reaches the derive (optional -> unavailable/LKG).
      st.catalogJobStatus = st.catalogHash ? ((byHash.get(st.catalogHash) || {}).fetch_status ?? (byHash.get(st.catalogHash) || {}).fetchStatus ?? null) : null;
    }
  };

  // Plan the current round for every account from its OWN SQP signal; record its canonical SQP hash.
  const planRound = () => state.map((st) => {
    const plan = planListingOptimizer({
      accountId: st.account.accountId, country: st.account.country, currency: st.account.currency,
      connections, asOf: st.asOf, sqpSignal: st.sqpSignal,
    });
    const sqp = plan.sources.find((s) => s.requestKey === "listing-optimizer:sqp-weekly");
    if (sqp) st.sqpHash = sqp.requestHash;
    const cat = plan.sources.find((s) => s.requestKey === "listing-optimizer:catalog");
    if (cat) st.catalogHash = cat.requestHash;
    return { st, plan };
  });

  // Which of an account's resolved sources are EXECUTED this round: SQP-weekly in R1; then the catalog in R2
  // ONLY when the SQP signal is a validated success. A disabled/failed/unvalidated SQP spends NO catalog.
  const submitKeys = (st, round) => {
    if (round === 0) return new Set(["listing-optimizer:sqp-weekly"]);
    const s = st.sqpSignal;
    const sqpValidated = !!s && s.status === "success" && s.validated === true;
    return sqpValidated ? new Set(["listing-optimizer:catalog"]) : new Set();
  };

  const jobsOf = (planned, round) => planned.flatMap(({ st, plan }) => {
    const keys = submitKeys(st, round);
    return plan.sources
      .filter((s) => keys.has(s.requestKey))
      .map((s) => plannedSourceJob("listing-optimizer", s, plan.bucket || bucket, DRIVER_CONNECTION_ID[plan.connectionId] || plan.connectionId, st.account.accountId));
  });

  const ownerIdSet = new Set();
  const rollup = { cycleId: null, rounds: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0, deferred: 0, deadlineReached: false, drained: false };
  let cycleId = null;
  for (let round = 0; round < maxRounds; round += 1) {
    // Per-invocation bounds are CUMULATIVE across every staged round: maxJobs caps the total source jobs
    // this invocation processes, and the deadline/reserve budget covers the WHOLE invocation. Once the
    // budget is spent, do NOT open the later catalog round -- a fresh invocation resumes from persisted
    // state without a duplicate POST (the SQP export is never re-created).
    const remaining = maxJobs === Infinity ? Infinity : Math.max(0, maxJobs - rollup.processed);
    if (remaining === 0) { rollup.drained = false; break; }
    if (round > 0) await reconstruct(cycleId);
    const planned = planRound();
    const plannedJobs = jobsOf(planned, round);
    for (const j of plannedJobs) ownerIdSet.add(j.owner.ownerId);
    const res = await runSourceJobs({ store, dataDoe, plannedJobs, ownerIds: [...ownerIdSet], bucket, cycleDate, scheduledAt, trigger, clock, deadlineMs, reserveMs, maxJobs: remaining, sourceTranche, reuseOnly });
    cycleId = res.cycleId;
    rollup.cycleId = cycleId;
    rollup.rounds = round + 1;
    rollup.processed += res.processed;
    rollup.succeeded += res.succeeded;
    rollup.failed += res.failed;
    rollup.skipped += res.skipped;
    rollup.deferred += res.deferred || 0;
    rollup.drained = res.drained;
    // Stop IMMEDIATELY on a wall-clock deadline or a resumable deferral: the invocation's budget is spent,
    // so the catalog round never starts (a deadline during the SQP poll thus prevents the catalog; the next
    // fresh invocation resumes the export + the catalog stage).
    if (res.deadlineReached) { rollup.deadlineReached = true; rollup.drained = false; break; }
    if ((res.deferred || 0) > 0) { rollup.drained = false; break; }
  }
  // Reconstruct each account's persisted SQP state ONE FINAL time BEFORE reading telemetry, so rollup is
  // fresh even after a one-round (or deadline-truncated) invocation -- never stale.
  if (cycleId) await reconstruct(cycleId);

  // Reconcile stale owner memberships ONLY against each account's COMPLETE authoritative resolved set, and
  // ONLY for accounts whose SQP is a validated success (SQP + catalog authoritative). An account whose SQP
  // is unresolved / failed / disabled defers reconciliation entirely, so a still-required SQP membership
  // from a prior invocation is never falsely retired. Never touches the shared canonical row or another
  // owner's membership.
  if (cycleId) {
    const authoritativeKeys = new Set();
    const reconcileOwnerIds = new Set();
    for (const st of state) {
      const s = st.sqpSignal;
      if (!s || s.status !== "success" || s.validated !== true) continue; // SQP unresolved -> defer
      const finalPlan = planListingOptimizer({
        accountId: st.account.accountId, country: st.account.country, currency: st.account.currency,
        connections, asOf: st.asOf, sqpSignal: s,
      });
      const src0 = finalPlan.sources[0];
      if (!src0) continue;
      const ownerId = sourceJobOwnerId({
        reportKey: "listing-optimizer",
        connectionId: DRIVER_CONNECTION_ID[finalPlan.connectionId] || finalPlan.connectionId,
        organizationFingerprint: src0.organizationFingerprint, accountScopeHash: src0.accountScopeHash,
      });
      if (!ownerId) continue;
      reconcileOwnerIds.add(ownerId);
      for (const src of finalPlan.sources) authoritativeKeys.add(`${ownerId}|${src.requestHash}`);
    }
    await reconcileStaleOwnerMemberships(store, cycleId, [...reconcileOwnerIds], authoritativeKeys);
  }

  rollup.perAccount = state.map((st) => ({
    accountId: st.account.accountId,
    connectionId: st.account.accountId.startsWith("dd-secondary:") ? "dd-secondary" : "primary",
    sqpHash: st.sqpHash,
    sqpSignal: st.sqpSignal,
  }));
  // Stale accounts whose owning connection is not configured: skipped read-only, zero jobs/calls spent.
  rollup.unavailableAccounts = unavailable;
  rollup.plannedReports = buildFinalReports({ state, connections, bucket });
  return rollup;
}

// A source job fetch_status is RESOLVED-to-a-non-success (the report derive must interpret it) only when it
// terminally failed or was skipped. An absent job (null), a still-'pending'/'attempted' (in-flight/deferred)
// job, or a 'succeeded' job is NOT such a resolution -- the source must stay REQUIRED so the report fetch
// gate keeps the report PENDING (or, for succeeded, lets it derive) rather than prematurely recording it.
function resolvedNonSuccess(status) {
  return status === "failed" || status === "skipped";
}

// Return the canonical listing-optimizer report request per account for its currently resolved SQP outcome:
// SQP-weekly always; + the content catalog when the SQP signal is a validated success.
//
// STATE-AWARE final dependency flags (partial-invocation lifecycle, mirroring Keyword Rank): a source's
// `optional` flag is derived from its OWN persisted job status so a bounded/deferred/multi-round invocation
// never exposes a runnable-but-incomplete report that would derive-fail and freeze last-known-good:
//   - SQP-weekly unstaged / pending / in-flight  => REQUIRED  => fetch gate keeps the report PENDING
//     (retryable in the SAME cycle); once succeeded it stays required (gate ready -> derive);
//   - SQP-weekly RESOLVED failed/disabled/skipped => OPTIONAL  => the gate passes it to the derive, which
//     produces the faithful sqpAvailable:false snapshot (durable degraded SOURCE_DISABLED) or unavailable/
//     last-known-good (non-disabled failure) -- the special Listing Optimizer outcomes are preserved;
//   - catalog unstaged / pending / in-flight     => REQUIRED  => report PENDING until the catalog stage
//     completes in a later round/invocation (then the SAME cycle derives + saves exactly once);
//   - catalog RESOLVED failed/skipped            => OPTIONAL  => derive => unavailable/last-known-good.
// This deliberately does NOT make everything optional (which would let an unstaged source derive-fail now)
// nor everything required (which would turn a degraded SQP into a hard block); the derive's own conditional
// dependency (REPORT_DERIVATIONS optionalRequestKeys) remains the fail-closed authority. Pure; no I/O.
function buildFinalReports({ state, connections, bucket }) {
  return state.map((st) => {
    const plan = planListingOptimizer({
      accountId: st.account.accountId, country: st.account.country, currency: st.account.currency,
      connections, asOf: st.asOf, sqpSignal: st.sqpSignal,
    });
    const sources = plan.sources.map((s) => {
      if (s.requestKey === "listing-optimizer:sqp-weekly") return { ...s, optional: resolvedNonSuccess(st.sqpJobStatus) };
      if (s.requestKey === "listing-optimizer:catalog") return { ...s, optional: resolvedNonSuccess(st.catalogJobStatus) };
      return { ...s, optional: false };
    });
    return {
      reportKey: "listing-optimizer",
      reportVersion: plan.reportVersion,
      accountId: plan.accountId,
      connectionId: DRIVER_CONNECTION_ID[plan.connectionId] || plan.connectionId,
      bucket: plan.bucket || bucket,
      sources,
      context: plan.context,
    };
  });
}
