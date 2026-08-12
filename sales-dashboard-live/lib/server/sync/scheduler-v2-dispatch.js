// Scheduler v2 -- ONE canonical, production-shaped SHADOW dispatcher.
//
// This is the single orchestration seam that turns "which reports are enabled for which primary accounts"
// into the correct source-cycle + report-derivation calls, WITHOUT knowing any report's internals. It routes
// each report key through EXACTLY ONE canonical path, shares one (bucket, cycle_date) cycle across every
// driver so identical canonical source hashes fetch once, threads a single cumulative maxJobs + wall-clock
// budget across all drivers, and finally derives the ready reports (zero DataDoe/network in the derive).
//
// SHADOW MODE: not wired to any cron/route; every current report control is locked (reportControlCatalog
// marks Scheduler v2 adapters not-ready), so a real invocation dispatches NOTHING and spends zero tokens. The
// store, dataDoe, account-directory provider, persisted-Ads readers and snapshot saver are all INJECTED, so
// the dispatcher is deterministic and offline-testable and makes no DataDoe/Supabase call of its own.
//
// It creates NO cron, route, migration, deployment or frontend wiring, and unlocks no report.

import { buildShadowReportPlan, SHADOW_PLANNED_REPORT_KEYS, STAGED_CYCLE_REPORT_KEYS } from "./report-planner.js";
import { runStagedSourceCycle, plannedSourceJob } from "./source-sync-driver.js";
import { runReportJobs } from "./report-worker.js";
import { runKeywordRankShadowCycle } from "./keyword-rank-cycle.js";
import { runSalesMoversShadowCycle } from "./sales-movers-cycle.js";
import { runPpcShadowCycle } from "./ppc-cycle.js";
import { runListingOptimizerShadowCycle } from "./listing-optimizer-cycle.js";
import { makePpcAdsContextLoader } from "./ppc-ads-loader.js";
import { reportControlCatalog } from "./report-controls.js";
import { DERIVED_ONLY_REPORT_KEYS } from "./report-derivation.js";
import { classifyDirectoryAccounts } from "../datadoe-connections.js";
import { bucketForCountry } from "./registry.js";

// The planner/organization-registry connection id ("primary" | "secondary") -> the source driver's
// fail-closed connection id ("primary" | "dd-secondary") that plannedSourceJob validates.
const DRIVER_CONNECTION_ID = { primary: "primary", secondary: "dd-secondary" };

// Each staged-cycle report key -> its ONE canonical account-scoped cycle runner. There is no other way to run
// these reports (buildShadowReportPlan rejects them fail-closed); the map is the dispatcher's routing table.
const STAGED_RUNNERS = Object.freeze({
  "keyword-rank": runKeywordRankShadowCycle,
  "sales-movers": runSalesMoversShadowCycle,
  "ppc-performance": runPpcShadowCycle,
  "listing-optimizer": runListingOptimizerShadowCycle,
});

/**
 * Classify a report key into its ONE canonical Scheduler-v2 dispatch route:
 *   - "staged"       : an account-scoped staged cycle (Keyword Rank / Sales Movers / PPC / Listing Optimizer);
 *   - "generic"      : the eager single-shot generic plan (buildShadowReportPlan + runStagedSourceCycle);
 *   - "derived-only" : owns no source contracts, derives from other saved snapshots -> spends ZERO exports;
 *   - "unsupported"  : no wired dispatch path -> the dispatcher fails closed rather than guessing.
 * The three known sets are the AUTHORITATIVE registries (report-planner + report-derivation), so this map can
 * never silently drift from what each subsystem can actually run.
 */
export function classifySchedulerV2ReportKey(reportKey) {
  const key = String(reportKey || "");
  if (STAGED_CYCLE_REPORT_KEYS.includes(key)) return "staged";
  if (SHADOW_PLANNED_REPORT_KEYS.includes(key)) return "generic";
  if (DERIVED_ONLY_REPORT_KEYS.includes(key)) return "derived-only";
  return "unsupported";
}

/**
 * Resolve which report keys this invocation should consider, from the report-level control plane:
 *   - a MANUAL request (manualReportKeys) runs EXACTLY the named keys (and only those);
 *   - a scheduled run selects the reports that are ready AND schedule-enabled.
 * Returns `{ requested, readySet, manual }`. `readySet` (reports whose adapter is runtime-ready) is used by the
 * dispatcher to keep a locked/not-ready report from spending a single export -- a manual request NEVER unlocks
 * a report. `controlCatalog` is injectable for offline tests; it defaults to the real reportControlCatalog,
 * under which every Scheduler v2 report is not-ready, so a production invocation selects nothing.
 */
export function selectSchedulerV2ReportKeys({ settings = [], manualReportKeys = null, controlCatalog = reportControlCatalog } = {}) {
  const catalog = controlCatalog(settings) || [];
  const readySet = new Set(catalog.filter((c) => c && c.ready).map((c) => c.reportKey));
  if (Array.isArray(manualReportKeys) && manualReportKeys.length) {
    return { requested: [...new Set(manualReportKeys.map(String))], readySet, manual: true };
  }
  const enabled = catalog.filter((c) => c && c.ready && c.scheduleEnabled).map((c) => c.reportKey);
  return { requested: enabled, readySet, manual: false };
}

// Turn a generic buildShadowReportPlan into the owner-decorated source jobs runStagedSourceCycle expects. The
// plan is STATIC (no signal-gated staging for the generic single-shot reports), so resolvePlan returns the
// same owned jobs each round; the driver reaches its fixpoint after one drained round.
const resolveFromGenericPlan = (plan) => () => ({
  sourceJobs: plan.reportRequests.flatMap((req) => req.sources.map(
    (s) => plannedSourceJob(req.reportKey, s, req.bucket, DRIVER_CONNECTION_ID[req.connectionId] || req.connectionId, req.accountId),
  )),
});

/**
 * Run ONE bounded SHADOW dispatch slice for a marketplace bucket. Returns a rollup (never a secret):
 *   { bucket, cycleId, manual, selected, lockedOut, derivedOnly, unavailableAccounts, accountsDispatched,
 *     spent, maxJobs, stoppedForBudget, drained, perUnit, reports }.
 *
 * Required injected collaborators: `connections` (getDataDoeConnections()), `discoverAccounts()` (async account
 * directory provider -- dynamic, so a newly connected primary account participates automatically), `store` +
 * `dataDoe` (the source/report cycle backends), and `saveSnapshot` (the shadow snapshot saver). PPC additionally
 * needs `ppcAdsProviders` (persisted-Ads readers). A repeated/fresh invocation resumes from persisted state and
 * creates NO duplicate export (each driver + runReportJobs is idempotent/checkpointable).
 */
export async function runSchedulerV2Shadow({
  bucket, cycleDate, asOf = null, asOfFor = null,
  settings = [], manualReportKeys = null, controlCatalog = reportControlCatalog,
  connections, discoverAccounts,
  store, dataDoe, saveSnapshot,
  ppcAdsProviders = null, loadDerivedContext = null,
  clock = () => Date.now(), deadlineMs = Infinity, reserveMs = 3_000, maxJobs = Infinity,
  scheduledAt = null, trigger = "manual",
}) {
  if (bucket !== "us" && bucket !== "non-us") {
    throw new Error(`runSchedulerV2Shadow requires an explicit cycle bucket of 'us' or 'non-us' (got "${bucket}").`);
  }
  if (typeof discoverAccounts !== "function") {
    throw new Error("runSchedulerV2Shadow requires an injected discoverAccounts() provider for dynamic primary-account discovery.");
  }

  // 1) SELECT the report keys via the control plane (locked/not-ready reports are never dispatched).
  const { requested, readySet, manual } = selectSchedulerV2ReportKeys({ settings, manualReportKeys, controlCatalog });

  // 2) CLASSIFY + fail closed BEFORE opening any cycle or spending any token. An unsupported/ambiguous key
  //    (a report with no wired dispatch path) is refused rather than mis-routed; a PPC dispatch without its
  //    persisted-Ads readers is refused for the same fail-closed reason.
  const routed = requested.map((k) => ({ reportKey: k, route: classifySchedulerV2ReportKey(k) }));
  const unsupported = routed.filter((r) => r.route === "unsupported").map((r) => r.reportKey);
  if (unsupported.length) {
    throw new Error(`runSchedulerV2Shadow: no canonical dispatch path for report key(s) [${unsupported.join(", ")}] (not generic-plannable, staged-cycle, or derived-only); refusing to dispatch (fail closed).`);
  }

  // Readiness gate: a source-backed (generic/staged) report that is NOT ready is LOCKED -> zero exports. A
  // derived-only report owns no source contracts (zero exports by construction) and is not token-gated.
  const dispatchable = [];
  const lockedOut = [];
  const derivedOnly = [];
  for (const r of routed) {
    if (r.route === "derived-only") { derivedOnly.push(r.reportKey); continue; }
    if (!readySet.has(r.reportKey)) { lockedOut.push(r.reportKey); continue; }
    dispatchable.push(r);
  }
  const dispatchSet = new Set(dispatchable.map((r) => r.reportKey));
  const genericKeys = SHADOW_PLANNED_REPORT_KEYS.filter((k) => dispatchSet.has(k)); // canonical order
  const stagedKeys = STAGED_CYCLE_REPORT_KEYS.filter((k) => dispatchSet.has(k));    // canonical order
  if (stagedKeys.includes("ppc-performance") && !ppcAdsProviders) {
    throw new Error("runSchedulerV2Shadow: dispatching ppc-performance requires injected ppcAdsProviders (persisted-Ads readers); refusing to dispatch (fail closed).");
  }

  // 3) DISCOVER accounts dynamically, classify PRIMARY-ONLY (a stale dd-secondary is skipped read-only and
  //    never routed through the primary key), and keep only this bucket's accounts. Nothing is hard-coded, so
  //    a newly connected primary account is included the moment discovery returns it.
  const directoryRows = (await discoverAccounts()) || [];
  const { active, unavailable } = classifyDirectoryAccounts(directoryRows, connections);
  const bucketAccounts = active
    .map((a) => ({ accountId: a.accountId ?? a.id, country: a.country, currency: a.currency, name: a.name }))
    .filter((a) => a.accountId && bucketForCountry(a.country) === bucket);

  const rollup = {
    bucket, cycleId: null, manual,
    selected: dispatchable.map((r) => r.reportKey), lockedOut, derivedOnly,
    unavailableAccounts: unavailable, accountsDispatched: bucketAccounts.map((a) => a.accountId),
    spent: 0, maxJobs, stoppedForBudget: false, drained: false, perUnit: [], reports: null,
  };
  const collectedReports = [];
  const budgetLeft = () => (maxJobs === Infinity ? Infinity : Math.max(0, maxJobs - rollup.spent));
  const outOfTime = () => deadlineMs !== Infinity && clock() >= deadlineMs - reserveMs;

  // 4) DISPATCH under ONE cumulative budget. Unit order is canonical: the generic group (one shared plan/cycle,
  //    so intra-generic shared hashes dedup) then each staged cycle. Every driver opens the SAME (bucket,
  //    cycle_date) cycle, so a canonical hash shared across reports (e.g. the no-date insight catalog) is
  //    created once and owner memberships keep the families isolated. maxJobs + the deadline are CUMULATIVE:
  //    before opening the next unit the dispatcher stops when the budget is spent, and a deferral/deadline
  //    inside a unit stops the invocation with pending/resumable state intact (a fresh call resumes with no
  //    duplicate create-export).
  const units = [];
  if (genericKeys.length) units.push({ kind: "generic", label: `generic:${genericKeys.join("+")}`, keys: genericKeys });
  for (const key of stagedKeys) units.push({ kind: "staged", label: key, reportKey: key });

  for (const unit of units) {
    if (budgetLeft() === 0 || outOfTime()) { rollup.stoppedForBudget = true; break; }
    const remaining = budgetLeft();
    let res;
    if (unit.kind === "generic") {
      const plan = buildShadowReportPlan({ accounts: bucketAccounts, reportKeys: unit.keys, connections, asOfFor });
      res = await runStagedSourceCycle({
        store, dataDoe, resolvePlan: resolveFromGenericPlan(plan),
        bucket, cycleDate, scheduledAt, trigger, clock, deadlineMs, reserveMs, maxJobs: remaining,
      });
      collectedReports.push(...plan.reportRequests);
    } else {
      const runner = STAGED_RUNNERS[unit.reportKey];
      const args = {
        accounts: bucketAccounts, connections, asOf, asOfFor, store, dataDoe,
        bucket, cycleDate, scheduledAt, trigger, clock, deadlineMs, reserveMs, maxJobs: remaining,
      };
      if (unit.reportKey === "ppc-performance") Object.assign(args, ppcAdsProviders);
      res = await runner(args);
      collectedReports.push(...(res.plannedReports || []));
    }
    rollup.cycleId = res.cycleId || rollup.cycleId;
    rollup.spent += res.processed || 0;
    rollup.perUnit.push({
      unit: unit.label, kind: unit.kind, cycleId: res.cycleId || null,
      processed: res.processed || 0, deferred: res.deferred || 0,
      deadlineReached: !!res.deadlineReached, drained: !!res.drained,
    });
    if (res.deadlineReached || (res.deferred || 0) > 0) { rollup.stoppedForBudget = true; break; }
  }

  // 5) DERIVE the ready reports from the SAVED source rows (PURE: zero DataDoe/network). runReportJobs gates
  //    each report on its own dependencies -- pending stays pending, blocked stays terminal, unavailable/
  //    invalid preserve last-known-good, and one failed report never blocks an unrelated ready one. Skipped
  //    entirely when no source cycle ran (nothing selected, or every selected report locked/derived-only).
  if (rollup.cycleId && collectedReports.length) {
    const derivedLoader = loadDerivedContext || (ppcAdsProviders ? makePpcAdsContextLoader(ppcAdsProviders) : null);
    rollup.reports = await runReportJobs({
      store, cycleId: rollup.cycleId,
      sourceRows: (h) => store.loadSourceRows(h),
      saveSnapshot, plannedReports: collectedReports,
      clock, deadlineMs, reserveMs,
      loadDerivedContext: derivedLoader || undefined,
    });
  }
  rollup.drained = !rollup.stoppedForBudget;
  return rollup;
}
