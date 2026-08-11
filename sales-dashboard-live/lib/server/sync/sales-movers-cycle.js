// Scheduler v2 -- account-scoped STAGED orchestration for Sales Movers (SHADOW MODE).
//
// Sales Movers anchors on a latest-completed-sales-date PROBE, then (only if the probe reports a real
// date) fetches two-week traffic + ads, a shared FBA inventory snapshot, and the shared catalog. This
// driver replans EACH account from ITS OWN persisted probe outcome, keyed by that account's canonical
// request HASH -- never a global request-key signal. It reuses the approved owner-model worker
// (runSourceJobs: one create-export per request_hash per cycle) + plannedSourceJob; a fresh invocation
// reconstructs the same account-scoped probe signal from persisted jobs + saved cache WITHOUT repeating
// any export. Downstream is staged ONLY after a validated probe with a date, so a no-data account spends
// ZERO downstream tokens.
//
// SHADOW MODE: not wired to any cron/route; Sales Movers stays locked. Injected store + dataDoe make it
// deterministic and offline-testable; it makes no DataDoe call itself.

import { runSourceJobs } from "./source-worker.js";
import { plannedSourceJob, reconcileStaleOwnerMemberships } from "./source-sync-driver.js";
import { salesMoversProbeSignal } from "./source-signals.js";
import { planSalesMovers } from "./report-planner.js";
import { bucketForCountry } from "./registry.js";
import { classifyDirectoryAccounts } from "../datadoe-connections.js";
import { sourceJobOwnerId } from "../source-identity.js";
import { isValidCalendarDate } from "./report-source-contracts.js";

// The planner/organization-registry connection id ("primary" | "secondary") -> the source driver's
// fail-closed connection id ("primary" | "dd-secondary") that plannedSourceJob validates.
const DRIVER_CONNECTION_ID = { primary: "primary", secondary: "dd-secondary" };

const PROBE_KEY = "sales-movers:sales-latest-probe";
const DOWNSTREAM_KEYS = ["sales-movers:traffic", "sales-movers:ads", "sales-movers:inventory", "sales-movers:catalog"];

// A probe signal has a usable reported date only when it is a validated success carrying a REAL calendar
// date (a no-date validated probe is a valid completed "data unavailable" state, not a staging trigger).
function probeHasDate(signal) {
  return !!signal && signal.status === "success" && signal.validated === true
    && signal.latestReportedDate != null && isValidCalendarDate(signal.latestReportedDate);
}

/**
 * Run the Sales Movers staged source cycle for a set of accounts, account-scoped by request hash.
 * `accounts`: [{ accountId, country, currency }]; `asOfFor(country)` (or per-account `asOf`, or a single
 * `asOf`) supplies the marketplace-local as-of date. Rounds:
 *   R1: the latest-sales-date probe only (per account).
 *   R2: from each account's reconstructed probe signal -> the two-window traffic + ads, shared inventory,
 *       shared catalog -- ONLY when the probe validated with a real reported date.
 * Idempotent: a repeated/fresh call re-derives from persisted state and creates NO duplicate exports.
 * Returns a rollup with per-account probe hashes/signals + the final plannedReports for runReportJobs.
 */
export async function runSalesMoversShadowCycle({
  accounts = [], connections, asOf = null, asOfFor = null, store, dataDoe,
  bucket, cycleDate, scheduledAt = null, trigger = "manual",
  clock = () => Date.now(), deadlineMs = Infinity, reserveMs = 3_000, maxJobs = Infinity, maxRounds = 2,
}) {
  // Primary-only safety: partition the directory against the CONFIGURED connections BEFORE any planning. A
  // stale `dd-secondary:` account (secondary org retired) is never planned, never routed to the primary
  // key, and its prefix/snapshots are untouched -- it is skipped read-only so it spends ZERO source jobs /
  // DataDoe calls and never fails the primary cycle.
  const { active, unavailable } = classifyDirectoryAccounts(accounts, connections);

  // Schedule-bucket isolation: every active account's planner bucket MUST equal the supplied cycle bucket,
  // so one cycle can never mix US and non-US schedules. Reject BEFORE opening a cycle or touching DataDoe.
  if (bucket !== "us" && bucket !== "non-us") {
    throw new Error(`runSalesMoversShadowCycle requires an explicit cycle bucket of 'us' or 'non-us' (got "${bucket}").`);
  }
  for (const a of active) {
    const accountBucket = bucketForCountry(a.country);
    if (accountBucket !== bucket) {
      throw new Error(`Sales Movers cycle bucket "${bucket}" does not match account "${a.accountId}" (country "${a.country}" resolves to bucket "${accountBucket}"); refuse to mix schedule buckets in one cycle.`);
    }
  }

  const asOfOf = (a) => (typeof asOfFor === "function" ? asOfFor(a.country) : (a.asOf || asOf));
  // Per-account tracked state; each account owns its probe canonical hash (account-scoped).
  const state = active.map((a) => ({ account: a, asOf: asOfOf(a), probeHash: null, probeSignal: null }));

  const loadRows = async (hash) => {
    if (!hash || !store.loadSourceRows) return null;
    try { const p = await store.loadSourceRows(hash); return p && Array.isArray(p.rows) ? p.rows : null; } catch (_e) { return null; }
  };

  // Reconstruct each account's typed probe signal from ITS OWN persisted probe job (by hash) + saved cache.
  const reconstruct = async (cycleId) => {
    const jobs = await store.listSourceJobs(cycleId);
    const byHash = new Map(jobs.map((j) => [j.request_hash ?? j.requestHash, j]));
    for (const st of state) {
      if (!st.probeHash) continue;
      const j = byHash.get(st.probeHash);
      const succeeded = !!j && (j.fetch_status ?? j.fetchStatus) === "succeeded";
      if (succeeded) {
        const rows = await loadRows(st.probeHash);
        // A cleanly-loaded array (even []) is a validated probe success; a missing/unreadable cache is
        // NOT (it must not activate downstream).
        st.probeSignal = rows === null
          ? { status: "failed", validated: false, latestReportedDate: null }
          : salesMoversProbeSignal({ status: "success", validated: true, rows });
      } else {
        st.probeSignal = j ? { status: j.terminal ? "terminal" : "failed", validated: false, latestReportedDate: null } : null;
      }
    }
  };

  // Plan the current round for every account from its OWN probe signal; record its canonical probe hash.
  const planRound = () => state.map((st) => {
    const plan = planSalesMovers({
      accountId: st.account.accountId, country: st.account.country, currency: st.account.currency,
      connections, asOf: st.asOf, probeSignal: st.probeSignal,
    });
    const pr = plan.sources.find((s) => s.requestKey === PROBE_KEY);
    if (pr) st.probeHash = pr.requestHash;
    return { st, plan };
  });

  // Which of an account's resolved sources are EXECUTED this round: the probe in R1; then (ONLY when the
  // probe validated with a real reported date) the two-window traffic + ads + shared inventory + catalog
  // in R2. A no-date / failed / unvalidated probe spends NO downstream token.
  const submitKeys = (st, round) => {
    if (round === 0) return new Set([PROBE_KEY]);
    if (round === 1 && probeHasDate(st.probeSignal)) return new Set(DOWNSTREAM_KEYS);
    return new Set();
  };

  const jobsOf = (planned, round) => planned.flatMap(({ st, plan }) => {
    const keys = submitKeys(st, round);
    return plan.sources
      .filter((s) => keys.has(s.requestKey))
      .map((s) => plannedSourceJob("sales-movers", s, plan.bucket || bucket, DRIVER_CONNECTION_ID[plan.connectionId] || plan.connectionId, st.account.accountId));
  });

  // Owner memberships: each Sales Movers account+org is ONE owner. Every staged source is a membership
  // under that owner_id; runSourceJobs processes only THIS cycle's owned+planned canonical jobs, so OTHER
  // report families sharing the (bucket, cycle_date) cycle are never touched, and shared inventory/catalog
  // canonical hashes still dedupe to one export across reports.
  const ownerIdSet = new Set();

  const rollup = { cycleId: null, rounds: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0, deferred: 0, deadlineReached: false, drained: false };
  let cycleId = null;
  for (let round = 0; round < maxRounds; round += 1) {
    // Per-invocation bounds are CUMULATIVE across rounds; once the budget is spent, do NOT open a later
    // downstream round -- a fresh invocation resumes from persisted state without a duplicate POST.
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
    // Stop IMMEDIATELY on a wall-clock deadline or a resumable deferral: the invocation's budget is spent,
    // so no later downstream round starts. (A deadline during the probe poll thus prevents downstream work;
    // the next fresh invocation resumes the export + later stages.)
    if (res.deadlineReached) { rollup.deadlineReached = true; rollup.drained = false; break; }
    if ((res.deferred || 0) > 0) { rollup.drained = false; break; }
  }
  // Reconstruct each account's persisted probe state ONE FINAL time BEFORE reading telemetry, so
  // rollup.perAccount is fresh even after a one-round (or deadline-truncated) invocation.
  if (cycleId) await reconstruct(cycleId);

  // Reconcile stale owner memberships ONLY against each account's COMPLETE AUTHORITATIVE resolved
  // dependency set (planSalesMovers for the resolved probe: probe alone for a no-date probe; probe +
  // downstream for a validated dated probe -- including sources not yet staged), and ONLY for accounts
  // whose probe is actually resolved this invocation (a validated success). A bounded/deadline/deferred
  // invocation that has NOT resolved an account's probe defers that account's reconciliation entirely, so a
  // still-required downstream membership from a prior invocation is never falsely retired. A genuinely
  // removed dependency (downstream once the probe reports no date again) is absent from the authoritative
  // set and correctly goes stale. This never touches the shared canonical row or another owner's membership.
  if (cycleId) {
    const authoritativeKeys = new Set();
    const reconcileOwnerIds = new Set();
    for (const st of state) {
      const p = st.probeSignal;
      if (!p || p.status !== "success" || p.validated !== true) continue; // probe unresolved -> defer
      const finalPlan = planSalesMovers({
        accountId: st.account.accountId, country: st.account.country, currency: st.account.currency,
        connections, asOf: st.asOf, probeSignal: p,
      });
      const src0 = finalPlan.sources[0];
      if (!src0) continue;
      const ownerId = sourceJobOwnerId({
        reportKey: "sales-movers",
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
    probeHash: st.probeHash,
    probeSignal: st.probeSignal,
  }));
  // Stale accounts whose owning connection is not configured: skipped read-only, zero jobs/calls spent.
  rollup.unavailableAccounts = unavailable;

  // Return the COMPLETE canonical report request per account (never filtered to already-staged hashes).
  // planSalesMovers emits EXACTLY the required set for the resolved probe (probe alone for a no-date probe;
  // probe + downstream for a validated dated probe), so a required dependency not yet staged simply has no
  // succeeded source job and the report FETCH GATE keeps the report PENDING (no derive/failure/snapshot)
  // until a later invocation stages + succeeds it -- then the SAME cycle derives + saves exactly once. A
  // failed/terminal probe still yields the approved honest blocked/unavailable outcome via the gate.
  rollup.plannedReports = buildFinalReports({ state, connections, bucket });
  return rollup;
}

// Return the canonical sales-movers report request per account for the account's currently resolved probe:
// the probe always; + two-window traffic/ads + shared inventory/catalog when the probe validated with a
// date. Each source is REQUIRED and listed regardless of whether it has been staged yet. Pure; no I/O.
function buildFinalReports({ state, connections, bucket }) {
  return state.map((st) => {
    const plan = planSalesMovers({
      accountId: st.account.accountId, country: st.account.country, currency: st.account.currency,
      connections, asOf: st.asOf, probeSignal: st.probeSignal,
    });
    const sources = plan.sources.map((s) => ({ ...s, optional: false }));
    return {
      reportKey: "sales-movers",
      reportVersion: plan.reportVersion,
      accountId: plan.accountId,
      connectionId: DRIVER_CONNECTION_ID[plan.connectionId] || plan.connectionId,
      bucket: plan.bucket || bucket,
      sources,
      context: plan.context,
    };
  });
}
