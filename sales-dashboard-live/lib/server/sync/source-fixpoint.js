// Scheduler v2 -- GLOBAL SOURCE-FAMILY FIXPOINT ORCHESTRATOR (offline-composable, ZERO ambient I/O).
//
// The missing layer above the per-tranche compositions: it PLANS the complete dependency graph first, then
// walks SOURCE_TRANCHE_ORDER draining ONE source family at a time -- every stable <=5-account batch of a
// family completes (terminal) before the next family launches -- re-entering the SAME (bucket, cycle_date)
// cycle across bounded continuations, with an at-least-one-minute completion-anchored cooldown between
// family launches (injected clock + injected waiter; tests NEVER sleep).
//
// Guarantees (each proven by scripts/source-fixpoint.test.js):
//   - the complete dependency graph is planned BEFORE any run; an unregistered or contradictory family
//     fails closed (source-registry);
//   - one family at a time, in SOURCE_TRANCHE_ORDER; a family with no work for the selected reports is
//     skipped without composing a runtime;
//   - a family is COMPLETE only when the durable cycle holds no pending/attempted job of that family --
//     never inferred from a narrowed pass's `drained` (a filtered tranche is NEVER globally drained);
//   - a previously attempted/failed request hash is never recreated (the worker's one-attempt claim +
//     skip-terminal; this layer additionally asserts no durable row ever exceeds one create);
//   - staged dependencies that surface AFTER their family's tranche already ran (e.g. a probe-activated
//     catalog/current-state job) are reached by bounded RE-WALKS of the same order over the same cycle;
//   - a terminal failure in a family REQUIRED by any selected report STOPS this bucket after that family
//     completes (no later family launches; LKG preserved; the other bucket's orchestration is a separate,
//     independent invocation and continues on its own);
//   - reports derive only after their required sources succeed (the existing per-report fetch gate; the
//     dispatcher derives on every pass but a gated report stays pending/blocked);
//   - cooldown: the NEXT family launches no earlier than cooldownMs after the PREVIOUS family completed --
//     completion-anchored, never a blind fixed offset; enforced through the injected clock/waiter only.
//
// This module performs NO DataDoe/Supabase I/O of its own: `composeRuntime(trancheSpec)` supplies the
// trusted per-tranche runtime (production: buildSchedulerV2SourceTrancheRuntime), and `store` is the same
// injected store the runtime uses (read here only through listSourceJobs). Nothing here creates a cron,
// route, deployment, or control-plane change.

import { SOURCE_TRANCHE_ORDER } from "./source-tranche.js";
import { REPORT_SOURCE_CONTRACTS } from "./report-source-contracts.js";
import { REPORT_DERIVATIONS, DERIVED_ONLY_REPORT_KEYS } from "./report-derivation.js";
import { sourceRegistryEntry, registryIsPremiumOf, trancheBudgetMode } from "./source-registry.js";

// The production budget planner the trusted composition threads to the dispatcher (Blocker 4d wiring):
// registry token classes price each hash; registry plan staticism decides which tranches freeze ceilings.
export function registryBudgetPlanner() {
  return Object.freeze({ isPremiumOf: registryIsPremiumOf, trancheBudgetMode });
}

const OPEN_STATUSES = new Set(["pending", "attempted"]);
const fetchStatusOf = (row) => row.fetch_status ?? row.fetchStatus ?? "pending";
const sourceKeyOf = (row) => row.source_key ?? row.sourceKey ?? "";

/**
 * PLAN the complete dependency graph for a reviewed report scope, BEFORE any execution:
 *   - every selected report's REQUIRED and OPTIONAL source families (from REPORT_SOURCE_CONTRACTS +
 *     REPORT_DERIVATIONS' optional request keys; a family required by ANY contract of a report is required);
 *   - the ordered tranches annotated with which selected reports require / optionally use them, and their
 *     registry budget mode.
 * FAIL CLOSED on an unknown report key, an unregistered family (source-registry throws typed
 * UNREGISTERED_SOURCE), or a family missing from the tranche order. Derived-only reports (brand-view /
 * priority-feed) contribute no families but are recorded (they ride on their upstream reports' sources).
 */
export function planSourceFixpointGraph({ reportKeys, trancheOrder = SOURCE_TRANCHE_ORDER } = {}) {
  if (!Array.isArray(reportKeys) || reportKeys.length === 0) {
    throw new Error("planSourceFixpointGraph requires a non-empty reportKeys array (fail closed).");
  }
  const familyToTranche = new Map();
  for (const t of trancheOrder) for (const k of t.sourceKeys) familyToTranche.set(k, t.name);

  const reports = {};
  for (const raw of reportKeys) {
    const reportKey = String(raw || "").trim();
    if (!reportKey) throw new Error("planSourceFixpointGraph: blank report key (fail closed).");
    if (DERIVED_ONLY_REPORT_KEYS.includes(reportKey)) {
      reports[reportKey] = Object.freeze({ reportKey, derivedOnly: true, requiredFamilies: Object.freeze([]), optionalFamilies: Object.freeze([]) });
      continue;
    }
    const contracts = REPORT_SOURCE_CONTRACTS[reportKey];
    if (!Array.isArray(contracts) || contracts.length === 0) {
      throw new Error(`planSourceFixpointGraph: report "${reportKey}" has no source contracts and is not derived-only; refusing (fail closed).`);
    }
    const optionalKeys = new Set((REPORT_DERIVATIONS[reportKey] && REPORT_DERIVATIONS[reportKey].optionalRequestKeys) || []);
    const required = new Set();
    const optionalOnly = new Set();
    for (const c of contracts) {
      const family = c && c.sourceKey;
      if (!family) continue; // a contract without a sourceKey is a derived input, never a source job
      sourceRegistryEntry(family); // typed UNREGISTERED_SOURCE on an unregistered dependency (fail closed)
      if (!familyToTranche.has(family)) {
        throw new Error(`planSourceFixpointGraph: family "${family}" (report "${reportKey}") is not in the tranche order; refusing (fail closed).`);
      }
      if (optionalKeys.has(c.requestKey)) optionalOnly.add(family);
      else required.add(family);
    }
    for (const f of required) optionalOnly.delete(f); // required by ANY contract => required
    reports[reportKey] = Object.freeze({
      reportKey, derivedOnly: false,
      requiredFamilies: Object.freeze([...required].sort()),
      optionalFamilies: Object.freeze([...optionalOnly].sort()),
    });
  }

  const tranches = trancheOrder.map((t) => {
    const requiredByReports = [];
    const optionalForReports = [];
    for (const r of Object.values(reports)) {
      if (r.requiredFamilies.some((f) => t.sourceKeys.includes(f))) requiredByReports.push(r.reportKey);
      else if (r.optionalFamilies.some((f) => t.sourceKeys.includes(f))) optionalForReports.push(r.reportKey);
    }
    return Object.freeze({
      name: t.name,
      sourceKeys: Object.freeze([...t.sourceKeys]),
      requiredByReports: Object.freeze(requiredByReports.sort()),
      optionalForReports: Object.freeze(optionalForReports.sort()),
      budgetMode: trancheBudgetMode(t),
    });
  });

  return Object.freeze({ reports: Object.freeze(reports), tranches: Object.freeze(tranches) });
}

// Count one family group's durable job states in the shared cycle.
async function readFamilyState(store, cycleId, keySet) {
  const state = { total: 0, pending: 0, attempted: 0, succeeded: 0, failed: 0, open: 0 };
  if (!cycleId) return state;
  const rows = await store.listSourceJobs(cycleId);
  for (const r of rows) {
    if (!keySet.has(sourceKeyOf(r))) continue;
    state.total += 1;
    const st = fetchStatusOf(r);
    if (st === "pending") state.pending += 1;
    else if (st === "attempted") state.attempted += 1;
    else if (st === "succeeded") state.succeeded += 1;
    else if (st === "failed") state.failed += 1;
  }
  state.open = state.pending + state.attempted;
  return state;
}

// Defense in depth for "never recreate a previously attempted request hash": no durable row may ever show
// more than one create-export. The DB check constraint + one-attempt claim make this unreachable; if it is
// ever observed the orchestrator aborts rather than continuing on a corrupted invariant.
async function assertNoDuplicateCreate(store, cycleId) {
  if (!cycleId) return;
  const rows = await store.listSourceJobs(cycleId);
  for (const r of rows) {
    const cec = r.create_export_count ?? r.createExportCount;
    if (typeof cec === "number" && cec > 1) {
      const err = new Error(`ORCHESTRATOR_DUPLICATE_CREATE: request hash has ${cec} create-exports in cycle ${cycleId}; aborting (fail closed).`);
      err.code = "ORCHESTRATOR_DUPLICATE_CREATE";
      throw err;
    }
  }
}

/**
 * Run the GLOBAL source-family fixpoint for ONE bucket. See the module header for the guarantees.
 *
 * Collaborators (all injected; no ambient I/O):
 *   composeRuntime(trancheSpec) -> runtime{ run(sliceArgs) }  -- the trusted per-tranche composition
 *     (production: (spec) => buildSchedulerV2SourceTrancheRuntime(spec, reviewedOverrides)). Composed ONCE
 *     per (family, walk); the tranche spec is fixed at compose time, never per run.
 *   store -- the SAME injected store the runtime uses; read here only via listSourceJobs.
 *   wait(ms) -- the cooldown waiter. REQUIRED when cooldownMs > 0. Tests inject a fake-clock advancer;
 *     production may timer-sleep. The orchestrator itself never calls setTimeout.
 *   clock() -- injected milliseconds clock (cooldown + completion anchoring). Never Date.now() directly.
 *
 * Returns a frozen rollup:
 *   { bucket, cycleId, walks, runs, families:[{name, walk, continuations, state, requiredByReports,
 *     budgetMode, skipped}], stopped, stopReason, globalDrained, reports, finalized, cycleStatus }.
 */
export async function runSourceFixpoint({
  composeRuntime, store,
  bucket, cycleDate, reportKeys,
  asOf = null, asOfFor = null,
  manualReportKeys = undefined, // default: the reviewed reportKeys scope (a manual, readiness-gated selection)
  clock = () => Date.now(),
  wait = null,
  cooldownMs = 60_000,
  maxContinuationsPerFamily = 6,
  maxWalks = 3,
  deadlineMs = Infinity, reserveMs = 3_000, maxJobs = Infinity,
  scheduledAt = null, trigger = "manual",
  trancheOrder = SOURCE_TRANCHE_ORDER,
} = {}) {
  if (typeof composeRuntime !== "function") {
    throw new Error("runSourceFixpoint requires an injected composeRuntime(trancheSpec) factory (fail closed).");
  }
  if (!store || typeof store.listSourceJobs !== "function") {
    throw new Error("runSourceFixpoint requires the injected store (listSourceJobs) for durable family-state reads (fail closed).");
  }
  if (bucket !== "us" && bucket !== "non-us") {
    throw new Error(`runSourceFixpoint requires an explicit bucket of 'us' or 'non-us' (got "${bucket}").`);
  }
  const cooldown = Number(cooldownMs);
  if (!Number.isFinite(cooldown) || cooldown < 0) {
    throw new Error("runSourceFixpoint: cooldownMs must be a non-negative finite number (fail closed).");
  }
  if (cooldown > 0 && typeof wait !== "function") {
    throw new Error("runSourceFixpoint: a positive cooldown requires an injected wait(ms) collaborator -- tests advance a fake clock, production may sleep; the orchestrator never sleeps on its own (fail closed).");
  }

  // 1) PLAN the complete dependency graph FIRST (fail closed before any run).
  const graph = planSourceFixpointGraph({ reportKeys, trancheOrder });
  const selection = manualReportKeys === undefined ? [...reportKeys] : manualReportKeys;

  const rollup = {
    bucket, cycleId: null, walks: 0, runs: 0, families: [],
    stopped: false, stopReason: null, globalDrained: false,
    reports: null, finalized: false, cycleStatus: null,
  };
  const runArgs = { bucket, cycleDate, asOf, asOfFor, manualReportKeys: selection, clock, deadlineMs, reserveMs, maxJobs, scheduledAt, trigger };

  let lastFamilyCompletedAt = null;
  const enforceCooldown = async () => {
    if (cooldown === 0 || lastFamilyCompletedAt == null) return;
    // Completion-anchored: at least `cooldown` ms after the previous family COMPLETED (never a blind fixed
    // offset). Loop-guarded so a waiter that under-advances the injected clock cannot break the floor.
    const target = lastFamilyCompletedAt + cooldown;
    while (clock() < target) await wait(Math.max(1, target - clock()));
  };

  outer:
  for (let walk = 0; walk < maxWalks; walk += 1) {
    rollup.walks = walk + 1;
    let anyRunThisWalk = false;

    for (const t of graph.tranches) {
      const hasSelectedWork = t.requiredByReports.length > 0 || t.optionalForReports.length > 0;
      if (!hasSelectedWork) {
        if (walk === 0) rollup.families.push(Object.freeze({ name: t.name, walk: walk + 1, continuations: 0, state: null, requiredByReports: t.requiredByReports, budgetMode: t.budgetMode, skipped: "no-selected-work" }));
        continue;
      }
      const keySet = new Set(t.sourceKeys);

      // Re-walks execute only families with durable OPEN work (a staged dependency that surfaced after the
      // family's own tranche already ran). Walk 1 always runs a family with selected work at least once --
      // its jobs may not exist durably yet.
      if (walk > 0) {
        const before = await readFamilyState(store, rollup.cycleId, keySet);
        if (before.open === 0) continue;
      }

      await enforceCooldown();
      const runtime = composeRuntime({ name: t.name, sourceKeys: [...t.sourceKeys] });
      if (!runtime || typeof runtime.run !== "function") {
        throw new Error(`runSourceFixpoint: composeRuntime returned no runnable runtime for tranche "${t.name}" (fail closed).`);
      }

      let continuations = 0;
      let state = await readFamilyState(store, rollup.cycleId, keySet);
      let stalls = 0;
      let prevSignature = null;
      while (continuations < maxContinuationsPerFamily) {
        const res = await runtime.run(runArgs);
        rollup.runs += 1;
        continuations += 1;
        anyRunThisWalk = true;
        rollup.cycleId = res.cycleId || rollup.cycleId;
        if (res.reports) rollup.reports = res.reports;
        if (res.finalized) { rollup.finalized = true; rollup.cycleStatus = res.cycleStatus; }
        await assertNoDuplicateCreate(store, rollup.cycleId);

        state = await readFamilyState(store, rollup.cycleId, keySet);
        if (state.open === 0) break; // family complete (every stable batch terminal)

        // Stall guard: a SECOND consecutive continuation with an identical durable family state, identical
        // spend, and NO resumable deferral means re-running cannot progress this family (e.g. a rehearsal
        // missing its reusable source); stop typed rather than loop. A pass that deferred resumable work is
        // legitimately waiting on DataDoe and never counts as a stall (bounded continuations still cap it).
        const deferredInPass = (res.perUnit || []).reduce((a, u) => a + (u.deferred || 0), 0);
        const signature = JSON.stringify(state) + "|" + String(res.spent || 0);
        if (deferredInPass > 0) stalls = 0;
        else if (signature === prevSignature) stalls += 1;
        else stalls = 0;
        prevSignature = signature;
        if (stalls >= 1) {
          rollup.stopped = true;
          rollup.stopReason = Object.freeze({ code: "FAMILY_STALLED", family: t.name, state: Object.freeze({ ...state }) });
          rollup.families.push(Object.freeze({ name: t.name, walk: walk + 1, continuations, state: Object.freeze({ ...state }), requiredByReports: t.requiredByReports, budgetMode: t.budgetMode, skipped: null }));
          break outer;
        }
      }

      rollup.families.push(Object.freeze({ name: t.name, walk: walk + 1, continuations, state: Object.freeze({ ...state }), requiredByReports: t.requiredByReports, budgetMode: t.budgetMode, skipped: null }));

      if (state.open > 0) {
        // Bounded continuations exhausted with work still open: stop this bucket typed. Everything durable
        // stays resumable (export ids persisted; no hash recreated); a fresh reviewed invocation resumes.
        rollup.stopped = true;
        rollup.stopReason = Object.freeze({ code: "FAMILY_CONTINUATIONS_EXHAUSTED", family: t.name, state: Object.freeze({ ...state }) });
        break outer;
      }

      lastFamilyCompletedAt = clock();

      // REQUIRED-SOURCE failure policy: a terminal failure in a family ANY selected report requires stops
      // THIS bucket after the family completes -- no later family launches, nothing is retried, no failed
      // hash is recreated, and every LKG snapshot stays intact. (The other bucket runs independently.)
      if (state.failed > 0 && t.requiredByReports.length > 0) {
        rollup.stopped = true;
        rollup.stopReason = Object.freeze({
          code: "REQUIRED_SOURCE_FAILED", family: t.name, failedJobs: state.failed,
          requiredBy: t.requiredByReports,
        });
        break outer;
      }
    }

    // Fixpoint check: when the whole cycle holds no open work, the walk converged. Otherwise another walk
    // picks up staged dependencies that surfaced late -- unless a full walk ran nothing (no progress possible).
    const allOpen = rollup.cycleId
      ? (await store.listSourceJobs(rollup.cycleId)).filter((r) => OPEN_STATUSES.has(fetchStatusOf(r))).length
      : 0;
    if (allOpen === 0) break;
    if (!anyRunThisWalk) break;
  }

  if (rollup.cycleId) {
    const rows = await store.listSourceJobs(rollup.cycleId);
    rollup.globalDrained = !rollup.stopped && rows.length > 0 && rows.every((r) => !OPEN_STATUSES.has(fetchStatusOf(r)));
  }
  rollup.families = Object.freeze(rollup.families);
  return Object.freeze(rollup);
}
