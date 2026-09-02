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
import { computeFrozenTrancheBudget } from "./source-tranche-budget.js";
import { resolveRolloutAccounts } from "./account-rollout.js";
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
import { accountInScope, isRoutingScope } from "./scheduler-scope.js";

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
    // A BATCHED seller-scoped report request (fba-plan) carries per-account owner metadata + a per-source
    // marketplace constraint; pass the account's individual rawSellerId + the batch marketplace so plannedSourceJob
    // computes this account's owner scope (accountScopeHash([rawSellerId])) and the source worker validates every
    // row against the batch marketplace. A single-account request (no owner / no marketplaceConstraint) passes null
    // for both and takes the byte-identical single-account path (backward compatible).
    (s) => plannedSourceJob(
      req.reportKey, s, req.bucket, DRIVER_CONNECTION_ID[req.connectionId] || req.connectionId, req.accountId,
      req.owner ? req.owner.rawSellerId : null,
      s.marketplaceConstraint != null ? s.marketplaceConstraint : null,
    ),
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
  loadAccountRollout = null,
  clock = () => Date.now(), deadlineMs = Infinity, reserveMs = 3_000, maxJobs = Infinity,
  scheduledAt = null, trigger = "manual",
  // OPTIONAL cycle-bucket NAMESPACE (operational arg). Defaults to `bucket` -> the scheduler-v2 path is byte-
  // identical. A dedicated operator (FBA Plan) passes e.g. "us-fba" so ITS sync_cycles rows never collide with the
  // scheduler-v2 daily (bucket, cycle_date) cycle; account discovery/rollout + every bucket validation use the real
  // `bucket`, ONLY the cycle key is namespaced.
  cycleBucket = null,
  // BUILD-TIME source-tranche selector (Part A). Supplied ONLY by the trusted composition
  // (buildSchedulerV2SourceTrancheRuntime); NEVER a per-run operational arg. When present, each source
  // unit executes only the selected families this pass; the full plan is still upserted, so the next
  // tranche resumes the same (bucket, cycle_date) cycle. null => execute everything (unchanged).
  sourceTranche = null,
  // BUILD-TIME reuseOnly REHEARSAL flag (Blocker 3). Supplied ONLY by the trusted composition; NEVER a
  // per-run operational arg. When true, every source unit creates ZERO exports -- a pending job that cannot
  // be satisfied by a durable cache adoption or a saved export_id resume returns MISSING_REUSABLE_SOURCE.
  reuseOnly = false,
  // BUILD-TIME budget planner (Blocker 4d wiring). Supplied ONLY by the trusted composition; NEVER a per-run
  // operational arg. Shape { isPremiumOf(job), trancheBudgetMode(spec) }. When present TOGETHER WITH a
  // sourceKeys-mode tranche whose member families are all statically plannable ("frozen"), the GENERIC unit's
  // create/AI-token ceilings are computed from its static plan, persisted per (cycle, `${tranche}#generic`)
  // BEFORE any execution, and threaded as the worker's reservation context -- so every generic create goes
  // through the atomic pre-POST reservation. Staged units run unbudgeted (their plans are signal-dependent);
  // the one-attempt-per-hash claim still bounds every one of their creates. null => byte-identical behavior.
  budgetPlanner = null,
}) {
  if (!isRoutingScope(bucket)) {
    throw new Error(`runSchedulerV2Shadow requires an explicit cycle scope (region india|europe-au|us-ca or legacy us|non-us; got "${bucket}").`);
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
  const drainedNoOp = (extra = {}) => ({
    bucket, cycleId: null, manual,
    selected: dispatchable.map((r) => r.reportKey), lockedOut, derivedOnly,
    unavailableAccounts: [], accountsDispatched: [],
    spent: 0, maxJobs, stoppedForBudget: false, drained: true, trancheDrained: true, continuationRequired: false, perUnit: [], reports: null,
    finalized: false, cycleStatus: null, // no cycle was opened -> nothing to finalize
    ...extra,
  });
  if (dispatchable.length === 0 && derivedOnly.length === 0) {
    return { ...drainedNoOp(), selected: [] };
  }

  // Gate-7 DURABLE ACCOUNT ROLLOUT -- an ADDITIONAL, INDEPENDENT gate for EVERY dispatch, SCHEDULED and
  // MANUAL alike. manualReportKeys selects REPORTS only; it can never widen ACCOUNT scope -- the durable
  // rollout state governs which accounts may spend, always. (An isolated canary that needs a specific
  // account scope uses the BUILD-TIME trusted canary composition -- buildSchedulerV2CanaryRuntime -- whose
  // exact ids are still intersected with FRESH primary discovery below; there is NO per-run bypass.) The
  // rollout state is loaded BEFORE discovery so a read/schema failure -- or the default zero-account state
  // -- performs ZERO discovery/cycle/store/DataDoe work (fail closed; no wildcard, no implicit fallback).
  if (typeof loadAccountRollout !== "function") {
    throw new Error("runSchedulerV2Shadow: every dispatch (scheduled AND manual) requires the trusted durable account-rollout loader (loadAccountRollout); refusing to dispatch (fail closed).");
  }
  const rolloutState = await loadAccountRollout();
  {
    // Probe the resolver with an EMPTY directory so the state's own normalization decides: a failed read, a
    // NONCANONICAL durable id, or an allowlist with no VALID id (blank / dd-secondary-prefixed rows are
    // dropped by the same shared implementation) can never select an account -- so none of them spends even
    // the read-only discovery call.
    const probe = resolveRolloutAccounts(rolloutState, []);
    if (probe.reason === "rollout-read-not-ok" || probe.reason === "rollout-noncanonical-id" || probe.reason === "allowlist-empty") {
      const drainReason = probe.reason === "allowlist-empty" ? "zero-accounts-enabled" : probe.reason;
      return drainedNoOp({ accountRollout: { selected: 0, reason: drainReason } });
    }
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
  let bucketAccounts = active
    .map((a) => ({ accountId: a.accountId ?? a.id, country: a.country, currency: a.currency, name: a.name }))
    .filter((a) => a.accountId && accountInScope(bucket, a.country));

  // Gate-7 rollout FILTER (EVERY dispatch, scheduled AND manual; applied BEFORE any cycle/source planning):
  // keep exactly the discovered primary accounts the durable state selects -- allowlist rows by EXACT public
  // id, or every primary account under the deliberate all-primary switch. Stale/unknown allowlist rows match
  // nothing and spend nothing. Zero selected accounts => a drained no-op with ZERO cycle/store/DataDoe writes.
  const resolved = resolveRolloutAccounts(rolloutState, bucketAccounts);
  bucketAccounts = resolved.accounts;
  const rolloutInfo = { selected: resolved.selectedIds.length, staleIds: resolved.staleIds, reason: resolved.reason };
  if (bucketAccounts.length === 0) {
    return drainedNoOp({ unavailableAccounts: unavailable, accountRollout: rolloutInfo });
  }

  const rollup = {
    bucket, cycleId: null, manual,
    selected: dispatchable.map((r) => r.reportKey), lockedOut, derivedOnly,
    unavailableAccounts: unavailable, accountsDispatched: bucketAccounts.map((a) => a.accountId),
    accountRollout: rolloutInfo,
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

  // Tranche-scoped OPEN-WORK probe (source-first orchestration). Under a narrowed tranche a unit's
  // owner-scoped `drained` is false BY DESIGN (its un-selected families stay pending), so it can never gate
  // unit-to-unit continuation. What CAN: whether the shared cycle still holds any pending/attempted job the
  // tranche SELECTS. Reading the durable rows (never a unit's rollup) keeps this honest across units --
  // a maxJobs-truncated unit leaves selected work open and stops the pass exactly like before.
  const trancheOpenWork = async () => {
    if (!sourceTranche || !rollup.cycleId) return false;
    const rows = await store.listSourceJobs(rollup.cycleId);
    return rows.some((r) => ["pending", "attempted"].includes(r.fetch_status ?? r.fetchStatus ?? "pending")
      && sourceTranche.selects({ sourceKey: r.source_key ?? r.sourceKey ?? "", requestHash: r.request_hash ?? r.requestHash ?? "" }));
  };

  for (const unit of units) {
    if (budgetLeft() === 0 || outOfTime()) { rollup.stoppedForBudget = true; break; }
    const remaining = budgetLeft();
    let res;
    if (unit.kind === "generic") {
      const plan = buildShadowReportPlan({ accounts: bucketAccounts, reportKeys: unit.keys, connections, asOfFor: genericAsOfFor });
      // Blocker 4d wiring: freeze + thread the GENERIC unit's create/AI-token ceilings when the trusted
      // composition supplied a budget planner and the tranche is statically plannable. The budget is
      // persisted BEFORE any execution (the cycle open is the same idempotent (bucket, cycle_date) upsert
      // runStagedSourceCycle performs); 'created'/'exists' proceed, plan drift RAISES from the store
      // (PLAN_BUDGET_MISMATCH -- fail closed, zero creates), any other acknowledgement fails closed here.
      let budget = null;
      if (sourceTranche && budgetPlanner && sourceTranche.mode === "sourceKeys"
        && budgetPlanner.trancheBudgetMode({ name: sourceTranche.name, sourceKeys: sourceTranche.sourceKeys }) === "frozen") {
        const plannedJobs = resolveFromGenericPlan(plan)().sourceJobs;
        const frozen = computeFrozenTrancheBudget({
          plannedJobs, sourceTranche, isPremiumOf: budgetPlanner.isPremiumOf,
          trancheKey: `${sourceTranche.name}#generic`,
        });
        if (frozen.maxCreates > 0) {
          if (typeof store.persistBudget !== "function") {
            throw new Error("runSchedulerV2Shadow: a frozen tranche budget is required but store.persistBudget is unavailable; refusing to execute (fail closed).");
          }
          const cycleId = await store.openCycle({ bucket: cycleBucket || bucket, cycleDate, scheduledAt, trigger });
          rollup.cycleId = rollup.cycleId || cycleId;
          const ack = await store.persistBudget({
            cycleId, trancheKey: frozen.trancheKey, planFingerprint: frozen.planFingerprint,
            maxCreates: frozen.maxCreates, maxTokens: frozen.maxTokens,
            hashes: frozen.hashes.map((h) => ({ requestHash: h.requestHash, tokenCost: h.tokenCost })),
          });
          if (ack !== "created" && ack !== "exists") {
            throw new Error(`runSchedulerV2Shadow: persisting the frozen tranche budget returned a malformed acknowledgement ("${ack}"); refusing to execute (fail closed).`);
          }
          budget = { trancheKey: frozen.trancheKey, planFingerprint: frozen.planFingerprint };
        }
      }
      res = await runStagedSourceCycle({
        store, dataDoe, resolvePlan: resolveFromGenericPlan(plan),
        bucket, cycleBucket, cycleDate, scheduledAt, trigger, clock, deadlineMs, reserveMs, maxJobs: remaining, sourceTranche, reuseOnly, budget,
      });
      collectedReports.push(...plan.reportRequests);
    } else {
      const runner = STAGED_RUNNERS[unit.reportKey];
      const args = {
        accounts: bucketAccounts, connections, asOf, asOfFor, store, dataDoe,
        bucket, cycleDate, scheduledAt, trigger, clock, deadlineMs, reserveMs, maxJobs: remaining, sourceTranche, reuseOnly,
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
    //
    // SOURCE-FIRST refinement: under a narrowed tranche a unit's owner-scoped `drained` is false BY DESIGN
    // (its un-selected families stay pending), so it cannot gate continuation -- if it did, unit 1 would
    // stop every tranche pass and the staged units would never execute their selected family. The honest
    // per-pass signal is the DURABLE tranche-scoped open-work probe: proceed to the next unit ONLY when the
    // shared cycle holds no pending/attempted job the tranche selects (a deferral/deadline still stops
    // first, and a maxJobs truncation leaves selected work open, which stops exactly as before). The
    // full-cycle `drained` below keeps its meaning: a filtered tranche is NEVER globally drained.
    if (res.deadlineReached || (res.deferred || 0) > 0) { rollup.stoppedForBudget = true; break; }
    if (sourceTranche) {
      if (await trancheOpenWork()) { rollup.stoppedForBudget = true; break; }
    } else if (res.drained !== true) { rollup.stoppedForBudget = true; break; }
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
  // Source-first telemetry: whether the SELECTED tranche families hold no open work in the shared cycle.
  // Distinct from `drained` on purpose -- a filtered pass can be tranche-complete while other families are
  // still pending, and MUST NOT be treated as globally drained (drained stays false in that case).
  rollup.trancheDrained = sourceTranche ? !(await trancheOpenWork()) : rollup.drained;

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
      // Rely ONLY on a sound positive acknowledgement: a terminal cycle object. Never leave drained=true after a
      // malformed positive (the store's wrapper already strictly validates; this is defense in depth).
      const terminalStatus = disp.cycle && typeof disp.cycle === "object" ? disp.cycle.status : null;
      if (!["succeeded", "partial", "failed"].includes(terminalStatus)) {
        throw new Error(`runSchedulerV2Shadow: malformed positive finalize acknowledgement (disposition "${d}" without a terminal cycle) for cycle ${rollup.cycleId}; failing closed.`);
      }
      rollup.finalized = d === "finalized";
      rollup.cycleStatus = terminalStatus;
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
