// Scheduler v2 -- account-scoped shadow cycle for PPC Performance (SHADOW MODE).
//
// PPC creates ZERO DataDoe Ads exports: every advertising figure is DERIVED from persisted Supabase Ads
// history. This driver loads + validates each account's persisted Ads ONCE (public account scope), turns it
// into the typed ads-currency signal, and lets that signal decide whether ANY DataDoe token is spent:
//   - Ads read failed / unvalidated / unseeded  -> plan NOTHING (zero tokens; report stays last-known-good);
//   - validated Ads, <= 1 currency               -> plan the OPTIONAL total-sales denominator + catalog;
//   - validated Ads,  > 1 currency               -> plan the catalog ONLY (TACoS unavailable by design).
// It reuses the approved owner-model worker (runSourceJobs: one create-export per request_hash per cycle) +
// plannedSourceJob; a repeated/fresh invocation re-loads the SAME persisted Ads + re-plans deterministically
// and creates NO duplicate export. SHADOW MODE: not wired to any cron/route; the persisted-Ads readers +
// store + dataDoe are injected so it is deterministic and offline-testable, and it makes no DataDoe Ads call.

import { runSourceJobs } from "./source-worker.js";
import { plannedSourceJob, reconcileStaleOwnerMemberships } from "./source-sync-driver.js";
import { planPpcPerformance } from "./report-planner.js";
import { loadPersistedPpcAds, ppcAdsCurrencySignalOf } from "./ppc-ads-loader.js";
import { bucketForCountry } from "./registry.js";
import { classifyDirectoryAccounts } from "../datadoe-connections.js";
import { sourceJobOwnerId } from "../source-identity.js";

// The planner/organization-registry connection id ("primary" | "secondary") -> the source driver's
// fail-closed connection id ("primary" | "dd-secondary") that plannedSourceJob validates.
const DRIVER_CONNECTION_ID = { primary: "primary", secondary: "dd-secondary" };
const TOTAL_SALES_KEY = "ppc-performance:oli-sales";

/**
 * Run the PPC shadow source cycle for a set of accounts, account-scoped. `accounts`: [{ accountId, country,
 * currency }]; `asOfFor(country)` (or per-account `asOf`, or a single `asOf`) supplies the as-of date.
 * `getAdsDailySourceRows` / `getAdsSyncStates` read the PERSISTED Ads history (never DataDoe). Idempotent:
 * a repeated/fresh call re-loads the same persisted Ads, re-plans, and creates NO duplicate exports. Returns
 * a rollup with per-account Ads status + the final plannedReports for runReportJobs (which loads the Ads rows
 * for the derive via makePpcAdsContextLoader). `getAdsSyncCoverage(accountId, sourceKey)` reads the DURABLE
 * successful coverage windows that gate Ads validity (unproven default coverage => the account plans nothing).
 */
export async function runPpcShadowCycle({
  accounts = [], connections, asOf = null, asOfFor = null, store, dataDoe,
  getAdsDailySourceRows, getAdsSyncStates, getAdsSyncCoverage,
  bucket, cycleDate, scheduledAt = null, trigger = "manual",
  clock = () => Date.now(), deadlineMs = Infinity, reserveMs = 3_000, maxJobs = Infinity, maxRounds = 2,
  sourceTranche = null, // BUILD-TIME source-tranche selector (Part A); passed through to runSourceJobs.
}) {
  // Primary-only safety: partition the directory against the CONFIGURED connections BEFORE any load/plan. A
  // stale `dd-secondary:` account (secondary org retired) is never loaded, never planned, never routed to
  // the primary key -- it is skipped read-only so it spends ZERO source jobs / DataDoe calls.
  const { active, unavailable } = classifyDirectoryAccounts(accounts, connections);

  if (bucket !== "us" && bucket !== "non-us") {
    throw new Error(`runPpcShadowCycle requires an explicit cycle bucket of 'us' or 'non-us' (got "${bucket}").`);
  }
  for (const a of active) {
    const accountBucket = bucketForCountry(a.country);
    if (accountBucket !== bucket) {
      throw new Error(`PPC cycle bucket "${bucket}" does not match account "${a.accountId}" (country "${a.country}" resolves to bucket "${accountBucket}"); refuse to mix schedule buckets in one cycle.`);
    }
  }

  const asOfOf = (a) => (typeof asOfFor === "function" ? asOfFor(a.country) : (a.asOf || asOf));
  const state = active.map((a) => ({ account: a, asOf: asOfOf(a), ads: null, adsSignal: null }));

  // Load + validate each account's PERSISTED Ads history ONCE (public account scope) and derive its typed
  // ads-currency signal. This is a Supabase read, NOT a DataDoe export -- PPC makes ZERO DataDoe Ads calls.
  for (const st of state) {
    st.ads = await loadPersistedPpcAds({ accountId: st.account.accountId, asOf: st.asOf, getAdsDailySourceRows, getAdsSyncStates, getAdsSyncCoverage });
    st.adsSignal = ppcAdsCurrencySignalOf(st.ads);
  }

  const planFor = (st) => planPpcPerformance({
    accountId: st.account.accountId, country: st.account.country, currency: st.account.currency,
    connections, asOf: st.asOf, adsCurrencySignal: st.adsSignal,
  });
  const planRound = () => state.map((st) => ({ st, plan: planFor(st) }));
  // No staged downstream: every planned source (catalog + gated total-sales) is submitted each round; a
  // bounded/deferred round resumes the rest next round (runSourceJobs dedups by request_hash + one-attempt).
  const jobsOf = (planned) => planned.flatMap(({ st, plan }) => plan.sources.map(
    (s) => plannedSourceJob("ppc-performance", s, plan.bucket || bucket, DRIVER_CONNECTION_ID[plan.connectionId] || plan.connectionId, st.account.accountId),
  ));

  const ownerIdSet = new Set();
  const rollup = { cycleId: null, rounds: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0, deferred: 0, deadlineReached: false, drained: false };
  let cycleId = null;
  for (let round = 0; round < maxRounds; round += 1) {
    // Per-invocation bounds are CUMULATIVE across rounds; once the budget is spent, do NOT open a later
    // round -- a fresh invocation resumes from persisted state without a duplicate POST.
    const remaining = maxJobs === Infinity ? Infinity : Math.max(0, maxJobs - rollup.processed);
    if (remaining === 0) { rollup.drained = false; break; }
    const planned = planRound();
    const plannedJobs = jobsOf(planned);
    for (const j of plannedJobs) ownerIdSet.add(j.owner.ownerId);
    const res = await runSourceJobs({ store, dataDoe, plannedJobs, ownerIds: [...ownerIdSet], bucket, cycleDate, scheduledAt, trigger, clock, deadlineMs, reserveMs, maxJobs: remaining, sourceTranche });
    cycleId = res.cycleId;
    rollup.cycleId = cycleId;
    rollup.rounds = round + 1;
    rollup.processed += res.processed;
    rollup.succeeded += res.succeeded;
    rollup.failed += res.failed;
    rollup.skipped += res.skipped;
    rollup.deferred += res.deferred || 0;
    rollup.drained = res.drained;
    if (res.deadlineReached) { rollup.deadlineReached = true; rollup.drained = false; break; }
    if ((res.deferred || 0) > 0) { rollup.drained = false; break; }
    // The plan has no staged rounds; once a round drains cleanly the plan is complete.
    if (res.drained) break;
  }

  // Reconcile stale owner memberships ONLY against each account's COMPLETE authoritative plan (catalog +
  // gated total-sales). An account whose Ads read is unvalidated planned NOTHING (no owner), so there is
  // nothing to reconcile -- and a genuinely removed dependency (total-sales dropped when the account becomes
  // multi-currency) is absent from the authoritative set and correctly goes stale. Never touches the shared
  // canonical row or another owner's membership.
  if (cycleId) {
    const authoritativeKeys = new Set();
    const reconcileOwnerIds = new Set();
    for (const st of state) {
      const plan = planFor(st);
      const src0 = plan.sources[0];
      if (!src0) continue; // Ads unvalidated => planned nothing => no owner to reconcile
      const ownerId = sourceJobOwnerId({
        reportKey: "ppc-performance",
        connectionId: DRIVER_CONNECTION_ID[plan.connectionId] || plan.connectionId,
        organizationFingerprint: src0.organizationFingerprint, accountScopeHash: src0.accountScopeHash,
      });
      if (!ownerId) continue;
      reconcileOwnerIds.add(ownerId);
      for (const s of plan.sources) authoritativeKeys.add(`${ownerId}|${s.requestHash}`);
    }
    await reconcileStaleOwnerMemberships(store, cycleId, [...reconcileOwnerIds], authoritativeKeys);
  }

  rollup.perAccount = state.map((st) => ({
    accountId: st.account.accountId,
    connectionId: st.account.accountId.startsWith("dd-secondary:") ? "dd-secondary" : "primary",
    adsStatus: st.ads ? st.ads.status : "unavailable",
    adsCurrencyCount: st.adsSignal ? st.adsSignal.currencyCount : null,
  }));
  rollup.unavailableAccounts = unavailable;
  rollup.plannedReports = buildFinalReports({ state, connections, bucket });
  return rollup;
}

// Return the canonical PPC report request per account: the REQUIRED catalog + (when the Ads context is
// validated with <= 1 currency) the OPTIONAL total-sales denominator. total-sales stays optional so its
// failure degrades ONLY TACoS via the derive, never blocking campaigns/ASINs/targets/search terms. An
// Ads-unvalidated account emits NO sources -- the derive then returns unavailable (LKG). Pure; no I/O.
function buildFinalReports({ state, connections, bucket }) {
  return state.map((st) => {
    const plan = planPpcPerformance({
      accountId: st.account.accountId, country: st.account.country, currency: st.account.currency,
      connections, asOf: st.asOf, adsCurrencySignal: st.adsSignal,
    });
    const sources = plan.sources.map((s) => ({ ...s, optional: s.requestKey === TOTAL_SALES_KEY }));
    return {
      reportKey: "ppc-performance",
      reportVersion: plan.reportVersion,
      accountId: plan.accountId,
      connectionId: DRIVER_CONNECTION_ID[plan.connectionId] || plan.connectionId,
      bucket: plan.bucket || bucket,
      sources,
      context: plan.context,
    };
  });
}
