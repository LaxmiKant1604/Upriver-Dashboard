// Scheduler v2 -- ONE canonical, production-shaped SHADOW dispatcher.
//
// This is the single orchestration seam that turns "which reports are enabled for which primary accounts"
// into the correct source-cycle + report-derivation calls, WITHOUT knowing any report's internals. It routes
// each report key through EXACTLY ONE canonical path, shares one (bucket, cycle_date) cycle across every
// driver so identical canonical source hashes fetch once, threads a single cumulative maxJobs + wall-clock
// budget across all drivers, and finally derives the ready reports (zero DataDoe/network in the derive).
//
// SHADOW MODE: not wired to any cron/route; readiness comes from the fail-closed schedulerV2ReportControlCatalog
// (Scheduler-v2 readiness, DISTINCT from Scheduler v1's `enabled`), whose v2-ready allowlist is EMPTY -- so
// every Scheduler v2 report, including the v1-live brand-sales, is locked and a real invocation (manual or
// scheduled) dispatches NOTHING and spends zero tokens. The store, dataDoe, account-directory provider,
// persisted-Ads readers and snapshot saver are all INJECTED, so the dispatcher is deterministic and
// offline-testable and makes no DataDoe/Supabase call of its own.
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
import { schedulerV2ReportControlCatalog } from "./report-controls.js";
import { DERIVED_ONLY_REPORT_KEYS } from "./report-derivation.js";
import { isValidCalendarDate } from "./report-source-contracts.js";
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
 * a report. `controlCatalog` is injectable for offline tests; it defaults to the fail-closed
 * schedulerV2ReportControlCatalog (Scheduler-v2 readiness, DISTINCT from Scheduler v1's `enabled`), under which
 * EVERY Scheduler v2 report -- including brand-sales, which Scheduler v1 runs live -- is not-ready, so a
 * production invocation (manual or scheduled) selects it into neither ready nor scheduled and spends zero exports.
 */
export function selectSchedulerV2ReportKeys({ settings = [], manualReportKeys = null, controlCatalog = schedulerV2ReportControlCatalog } = {}) {
  const catalog = controlCatalog(settings) || [];
  const readySet = new Set(catalog.filter((c) => c && c.ready).map((c) => c.reportKey));
  // A MANUAL request is ANY array of keys (blocker 3). manualReportKeys = [] is a VALID manual selection
  // that runs ZERO reports and spends ZERO exports -- it must NEVER fall back to the scheduled enabled set.
  // Only null/undefined means "not a manual request" (use the schedule). A non-null, non-array value is a
  // MALFORMED manual input and fails closed: a manual request must name a concrete list of report keys.
  if (manualReportKeys != null) {
    if (!Array.isArray(manualReportKeys)) {
      throw new Error(`selectSchedulerV2ReportKeys: manualReportKeys must be an array of report keys when provided (got ${typeof manualReportKeys}); refusing to select (fail closed).`);
    }
    // Every entry must be a non-empty report-key string/number; a null / blank / object / array entry is
    // malformed and fails closed rather than coercing to "null" / "[object Object]" and mis-routing it.
    const keys = manualReportKeys.map((k) => {
      if (typeof k !== "string" && typeof k !== "number") {
        throw new Error("selectSchedulerV2ReportKeys: every manualReportKeys entry must be a report-key string; refusing to select (fail closed).");
      }
      const key = String(k).trim();
      if (!key) throw new Error("selectSchedulerV2ReportKeys: manualReportKeys contains a blank report key; refusing to select (fail closed).");
      return key;
    });
    return { requested: [...new Set(keys)], readySet, manual: true };
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
 * Compose several report-worker `loadDerivedContext` callbacks into ONE that invokes each and MERGES their
 * results (blocker 2). Every derived-context loader is scoped to a SINGLE report family and returns `{}`
 * for every other report (Daily's general loader emits `{ adsCoverage }` only for daily-reporting;
 * makePpcAdsContextLoader emits `{ ppcAds }` only for ppc-performance), so exactly the RELEVANT loader
 * contributes per report and the merge is disjoint -- one loader can NEVER suppress another. A single
 * invocation that contains BOTH Daily Reporting and PPC therefore derives Daily `adsCoverage` from the
 * injected general loader AND PPC `ppcAds` from the PPC loader. A loader that throws contributes nothing
 * (its fields are simply absent) but never breaks a sibling. Returns null when no loader is supplied and
 * the single loader unchanged when only one is, so the common paths stay allocation-free.
 */
export function composeDerivedContextLoaders(loaders) {
  const fns = (loaders || []).filter((fn) => typeof fn === "function");
  if (fns.length === 0) return null;
  if (fns.length === 1) return fns[0];
  return async (args) => {
    const merged = {};
    for (const fn of fns) {
      let part = null;
      try { part = await fn(args); } catch (_e) { part = null; }
      if (part && typeof part === "object" && !Array.isArray(part)) Object.assign(merged, part);
    }
    return merged;
  };
}

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
  settings = [], manualReportKeys = null, controlCatalog = schedulerV2ReportControlCatalog,
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

  // Blocker 4: a locked invocation with NOTHING to dispatch (no ready source-backed report AND no derived-only
  // report) performs ZERO I/O -- return a deterministic drained rollup BEFORE discoverAccounts, cycle creation,
  // or ANY store/DataDoe call. Under the default fail-closed v2 catalog EVERY report is locked, so a real
  // manual OR scheduled invocation returns here without touching discovery, the store, or DataDoe.
  if (dispatchable.length === 0 && derivedOnly.length === 0) {
    return {
      bucket, cycleId: null, manual,
      selected: [], lockedOut, derivedOnly,
      unavailableAccounts: [], accountsDispatched: [],
      spent: 0, maxJobs, stoppedForBudget: false, drained: true, continuationRequired: false, perUnit: [], reports: null,
      finalized: false, cycleStatus: null, // no cycle was opened -> nothing to finalize
    };
  }

  const dispatchSet = new Set(dispatchable.map((r) => r.reportKey));
  const genericKeys = SHADOW_PLANNED_REPORT_KEYS.filter((k) => dispatchSet.has(k)); // canonical order
  const stagedKeys = STAGED_CYCLE_REPORT_KEYS.filter((k) => dispatchSet.has(k));    // canonical order
  if (stagedKeys.includes("ppc-performance") && !ppcAdsProviders) {
    throw new Error("runSchedulerV2Shadow: dispatching ppc-performance requires injected ppcAdsProviders (persisted-Ads readers); refusing to dispatch (fail closed).");
  }

  // Blocker 5: generic single-shot planning needs a marketplace-local as-of PER account. Prefer the
  // injected per-country asOfFor(country); when it is absent, fall back to the VALIDATED global asOf for
  // EVERY account so generic windows are still the exact canonical ones (never account.asOf = undefined,
  // which would silently break every date window). If there is generic work to do and neither a valid
  // asOfFor function nor a valid global asOf is available, fail closed BEFORE opening any cycle.
  let genericAsOfFor = asOfFor;
  if (genericKeys.length && typeof genericAsOfFor !== "function") {
    const globalAsOf = asOf == null ? "" : String(asOf);
    if (!isValidCalendarDate(globalAsOf)) {
      throw new Error(`runSchedulerV2Shadow: generic report planning requires either an asOfFor(country) function or a valid global asOf (YYYY-MM-DD); got asOf="${asOf}". Refusing to plan (fail closed).`);
    }
    genericAsOfFor = () => globalAsOf;
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
    spent: 0, maxJobs, stoppedForBudget: false, drained: false, continuationRequired: false, perUnit: [], reports: null,
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
      const plan = buildShadowReportPlan({ accounts: bucketAccounts, reportKeys: unit.keys, connections, asOfFor: genericAsOfFor });
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
    // A unit is INCOMPLETE when it hit the wall-clock deadline, deferred a resumable poll/download, OR
    // truncated on maxJobs (drained:false with NO deadline/deferral). Any of these means work remains, so
    // the dispatcher STOPS here -- it neither opens the next unit nor later declares itself drained while a
    // prior unit still has pending/resumable state. A fresh idempotent invocation resumes from persisted
    // state with no duplicate create-export (blocker 6).
    if (res.deadlineReached || (res.deferred || 0) > 0 || res.drained !== true) { rollup.stoppedForBudget = true; break; }
  }

  // 5) DERIVE the ready reports from the SAVED source rows (PURE: zero DataDoe/network). runReportJobs gates
  //    each report on its own dependencies -- pending stays pending, blocked stays terminal, unavailable/
  //    invalid preserve last-known-good, and one failed report never blocks an unrelated ready one. Skipped
  //    entirely when no source cycle ran (nothing selected, or every selected report locked/derived-only).
  if (rollup.cycleId && collectedReports.length) {
    // Blocker 2: COMPOSE the derived-context loaders so a single invocation containing BOTH Daily Reporting
    // and PPC derives Daily `adsCoverage` from the injected general loader AND PPC `ppcAds` from
    // makePpcAdsContextLoader. Each loader is report-scoped (returns {} for other reports), so the two never
    // suppress each other; the worker still invokes the composed loader once per report and merges safely.
    const derivedLoader = composeDerivedContextLoaders([
      loadDerivedContext,
      ppcAdsProviders ? makePpcAdsContextLoader(ppcAdsProviders) : null,
    ]);
    rollup.reports = await runReportJobs({
      store, cycleId: rollup.cycleId,
      sourceRows: (h) => store.loadSourceRows(h),
      saveSnapshot, plannedReports: collectedReports,
      clock, deadlineMs, reserveMs,
      loadDerivedContext: derivedLoader || undefined,
    });
  }
  // Blocker 6: `drained` is computed from ACTUAL unit outcomes, never merely "did not stop for budget". It
  // is true ONLY when EVERY planned source unit was opened AND fully drained (no deadline / deferral /
  // maxJobs truncation) AND the derive half (when it ran) also drained. A final/only unit returning
  // drained:false -- including a maxJobs truncation with no deadline/deferral -- therefore makes the
  // dispatcher drained:false and flags that continuation is required (a fresh invocation resumes).
  const allUnitsDrained = rollup.perUnit.length === units.length && rollup.perUnit.every((u) => u.drained === true);
  const reportsDrained = !rollup.reports || rollup.reports.drained === true;
  rollup.drained = allUnitsDrained && reportsDrained && !rollup.stoppedForBudget;
  rollup.continuationRequired = !rollup.drained;

  // 6) FINALIZE the shared cycle -- the CANONICAL DISPATCHER owns this; a source-family driver must NEVER
  //    finalize the shared (bucket, cycle_date) cycle early. SCOPE SEMANTICS (fixes the manual-subset hole):
  //    auto-finalization is attempted ONLY for a COMPLETE SCHEDULED scope. A scheduled run plans + upserts its
  //    ENTIRE ready+scheduled scope before draining, so "no open child jobs" is a genuine complete-cycle signal.
  //    A MANUAL run is a partial subset that must NEVER terminalize the shared cycle -- a later manual run for a
  //    different report may still append to the same (bucket, cycleDate) -- so a manual run leaves the cycle
  //    running and is closed only by an explicit reviewed operation (Appendix N). Non-drained / deferred /
  //    deadline / maxJobs-truncated runs never call finalization.
  //
  //    The store's finalize (finalize_sync_cycle RPC -- 20260815_sync_cycle_finalize.sql) returns a TOTAL TYPED
  //    disposition; the dispatcher acts on each case and NEVER claims success while finalization is unavailable.
  rollup.finalized = false;
  rollup.cycleStatus = null;
  if (rollup.drained && rollup.cycleId && !manual) {
    if (typeof store.finalizeCycle !== "function") {
      // A lifecycle-enabled deployment must never report a drained scheduled cycle as complete while
      // finalization is unavailable: fail closed rather than silently no-op.
      throw new Error("runSchedulerV2Shadow: cycle finalization is unavailable (store.finalizeCycle missing); refusing to complete a drained scheduled cycle (fail closed).");
    }
    const disp = await store.finalizeCycle({ cycleId: rollup.cycleId });
    const d = disp && disp.disposition;
    if (d === "finalized" || d === "already-terminal") {
      // The cycle is complete (this run closed it, or another already did). drained stays true / continuation false.
      rollup.finalized = d === "finalized";
      rollup.cycleStatus = (disp.cycle && disp.cycle.status) || (d === "already-terminal" ? "terminal" : null);
    } else if (d === "open-work") {
      // The WHOLE cycle still has open source/report work (a concurrent scope). Re-observe on a fresh
      // invocation: this run is NOT the completion of the cycle.
      rollup.drained = false;
      rollup.continuationRequired = true;
      rollup.cycleStatus = "running";
    } else {
      // not-found / invalid-status / unknown / malformed -> fail closed (never claim a completed cycle).
      throw new Error(`runSchedulerV2Shadow: unexpected finalize disposition "${d}" for cycle ${rollup.cycleId}; failing closed.`);
    }
  }
  return rollup;
}
