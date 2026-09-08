// CANONICAL SCHEDULED-FAMILY RELEASE GUARD (the ONE place every AUTOMATIC scheduler family declares its
// production contract). Complements report-materialization-registry.js (which declares how a report SNAPSHOT is
// produced/served) by declaring how each SCHEDULED SOURCE/JOB family behaves in the automatic pipeline. A future
// scheduled family cannot ship unless it declares, and its declaration passes the guard, the SEVEN fields below:
//   schedulerOwner            -- which scheduler-v2 job/operator runs it (a real job id).
//   dependencies              -- the families it depends on (drives ordering + gating).
//   frozenPlanParticipation   -- how it participates in the frozen daily-cycle plan (P0-A).
//   ceiling                   -- the token/create ceiling model (never "unbounded").
//   completionOutput          -- the machine-readable signal proving it COMPLETED (P1: a real contract, not
//                                needs.<job>.result == 'success').
//   partialBehavior           -- what a partial/incomplete run does (must stay honestly partial; never false-green).
//   watchdogIdempotency       -- why a watchdog replay creates no duplicate work.
// This registry changes NO formula, owner, cadence, or token price -- it DOCUMENTS + ENFORCES today's contract and
// blocks an undeclared future family. 7-bit ASCII, LF.

const S = (v) => (v == null ? "" : String(v));

// ---- Controlled vocabularies (a declaration field with a value outside its enum fails the guard) ----------------
export const SCHEDULER_OWNERS = Object.freeze([
  "scheduler-v2:run",              // oli-refresh-d1.mjs (the OLI step of the daily cycle)
  "scheduler-v2:priority",         // priority-dashboards-release.mjs (drains Catalog + derives + publishes)
  "scheduler-v2:fba",              // fba-plan-golive.mjs (own cycle bucket)
  "scheduler-v2:listing-health-v3",// the shadow v3 ingestion (UI flag off)
  "scheduler-v2:materialize",      // report-materialization.mjs (zero export)
  "scheduler-v2:materialize-inventory", // report-materialization-brandview (zero export)
]);
export const FROZEN_PLAN_PARTICIPATION = Object.freeze([
  "freeze-and-execute",                        // frozen + executed in ITS step (OLI)
  "freeze-in-oli-step-execute-in-priority-step", // P0-A: frozen up front in the OLI step, drained by the priority step (Catalog)
  "own-cycle",                                 // a DEDICATED cycle bucket, not the daily (bucket, date) cycle (FBA, v3 shadow)
  "none",                                      // no frozen source plan (zero-export materialization)
]);
export const CEILING_MODELS = Object.freeze([
  "computed-per-region",  // ceiling computed from the region's account/batch count (never a static floor)
  "one-org-export",       // exactly one organization export (Catalog)
  "computed-per-account", // one export per account (FBA)
  "zero-export",          // materialization reuses durable evidence; zero DataDoe creates/tokens
]);
export const COMPLETION_OUTPUTS = Object.freeze([
  "oli-assessment-ok",       // the OLI operator's RESULT json ok (drained + within ceiling)
  "cycle-drained-finalized", // globalDrained + finalize succeeded/partial (priority)
  "fba_complete-job-output", // P1: fba-plan-golive emits fba_complete to $GITHUB_OUTPUT; the job exports it
  "terminal-succeeded-gate", // only a terminal 'succeeded' ingestion counts (v3 honest finalize)
  "materialize-count",       // the count of materialized snapshots (zero-export jobs)
]);
export const PARTIAL_BEHAVIORS = Object.freeze([
  "d1-provisional-final-lkg", // publish real itemized D-1 as provisional, promote to final; never fabricate; LKG retained
  "defer-typed-lkg",          // a not-ready/not-drained run defers typed; nothing published; LKG preserved
  "stay-visibly-partial",     // a partial region stays partial (never a fabricated zero, never marked fully fresh)
  "skip-typed-zero-creates",  // gated off with a typed reason; zero creates/tokens
]);
export const WATCHDOG_IDEMPOTENCY = Object.freeze([
  "operation-key-frozen-budget", // idempotent operation key + frozen tranche budget + reservation + idempotent cache
  "own-cycle-lkg",               // dedicated cycle + LKG (a replay re-proves, never duplicates)
  "idempotent-replay",           // replay re-derives to the same durable identities (0/0)
]);

export const REQUIRED_FAMILY_DECLARATION_FIELDS = Object.freeze([
  "family", "schedulerOwner", "dependencies", "frozenPlanParticipation", "ceiling",
  "completionOutput", "partialBehavior", "watchdogIdempotency",
]);

// The scheduled families that run in the AUTOMATIC pipeline today. Each MUST be declared; the guard test cross-checks
// that the durable daily source families (OLI/Catalog/FBA) are all present and that the P0-A/P1 contracts hold.
export const SCHEDULED_FAMILY_REGISTRY = Object.freeze({
  "order-line-items": {
    family: "order-line-items",
    schedulerOwner: "scheduler-v2:run",
    dependencies: [],
    frozenPlanParticipation: "freeze-and-execute",
    ceiling: "computed-per-region",
    completionOutput: "oli-assessment-ok",
    partialBehavior: "d1-provisional-final-lkg",
    watchdogIdempotency: "operation-key-frozen-budget",
    notes: "The OLI step freezes OLI AND the org Product Catalog (P0-A) into ONE cycle before the first paid create, then executes ONLY OLI.",
  },
  "product-catalog": {
    family: "product-catalog",
    schedulerOwner: "scheduler-v2:priority",
    dependencies: ["order-line-items"],
    frozenPlanParticipation: "freeze-in-oli-step-execute-in-priority-step",
    ceiling: "one-org-export",
    completionOutput: "cycle-drained-finalized",
    partialBehavior: "defer-typed-lkg",
    watchdogIdempotency: "operation-key-frozen-budget",
    notes: "P0-A: frozen into the daily cycle by the OLI step; drained by the priority step as a case-(a) continuation (never case-c not-drained). Legacy OLI-only cycles are recovered by finalize + supersede (P0-B).",
  },
  "fba-inventory-health": {
    family: "fba-inventory-health",
    schedulerOwner: "scheduler-v2:fba",
    dependencies: ["order-line-items"],
    frozenPlanParticipation: "own-cycle",
    ceiling: "computed-per-account",
    completionOutput: "fba_complete-job-output",
    partialBehavior: "stay-visibly-partial",
    watchdogIdempotency: "own-cycle-lkg",
    notes: "P1: fba-plan-golive.mjs emits a machine-readable fba_complete to $GITHUB_OUTPUT; the fba job exports it. A partial region stays visibly partial (Canada LATEST_SNAPSHOT_INCOMPLETE never fabricates a zero).",
  },
  "listing-health-v3": {
    family: "listing-health-v3",
    schedulerOwner: "scheduler-v2:listing-health-v3",
    dependencies: ["fba-inventory-health"],
    frozenPlanParticipation: "own-cycle",
    ceiling: "computed-per-region",
    completionOutput: "terminal-succeeded-gate",
    partialBehavior: "skip-typed-zero-creates",
    watchdogIdempotency: "idempotent-replay",
    notes: "P1: runs ONLY when needs.fba.outputs.fba_complete == 'true' (a real completeness contract, not needs.fba.result == 'success'); when FBA is partial it skips with a typed reason and zero creates/tokens.",
  },
  "materialize": {
    family: "materialize",
    schedulerOwner: "scheduler-v2:materialize",
    dependencies: ["order-line-items"],
    frozenPlanParticipation: "none",
    ceiling: "zero-export",
    completionOutput: "materialize-count",
    partialBehavior: "defer-typed-lkg",
    watchdogIdempotency: "idempotent-replay",
    notes: "Zero-export report materialization (reuses the serve derives); independent of the fba result, LKG-preserving.",
  },
  "materialize-inventory": {
    family: "materialize-inventory",
    schedulerOwner: "scheduler-v2:materialize-inventory",
    dependencies: ["order-line-items", "fba-inventory-health", "materialize"],
    frozenPlanParticipation: "none",
    ceiling: "zero-export",
    completionOutput: "materialize-count",
    partialBehavior: "stay-visibly-partial",
    watchdogIdempotency: "idempotent-replay",
    notes: "Zero-export brand-inventory materialization; never gates on fba.result, LKG-preserving.",
  },
});

// The durable daily-cycle source families the guard REQUIRES to be declared (the paid pipeline core).
export const REQUIRED_DAILY_FAMILIES = Object.freeze(["order-line-items", "product-catalog", "fba-inventory-health"]);

/**
 * PURE: validate ONE scheduled-family declaration against the required fields + controlled vocabularies. Returns
 * { ok, problems }. A missing field, an out-of-enum value, or a dependency that is not itself a declared family fails.
 */
export function validateScheduledFamilyDeclaration(decl, { knownFamilies = null } = {}) {
  const problems = [];
  if (!decl || typeof decl !== "object") return { ok: false, problems: ["declaration is not an object"] };
  for (const f of REQUIRED_FAMILY_DECLARATION_FIELDS) {
    if (!(f in decl)) problems.push(`missing required field: ${f}`);
  }
  const inEnum = (field, value, enumArr) => { if (!enumArr.includes(S(value))) problems.push(`${field}="${S(value)}" is not one of ${enumArr.join("|")}`); };
  if ("schedulerOwner" in decl) inEnum("schedulerOwner", decl.schedulerOwner, SCHEDULER_OWNERS);
  if ("frozenPlanParticipation" in decl) inEnum("frozenPlanParticipation", decl.frozenPlanParticipation, FROZEN_PLAN_PARTICIPATION);
  if ("ceiling" in decl) inEnum("ceiling", decl.ceiling, CEILING_MODELS);
  if ("completionOutput" in decl) inEnum("completionOutput", decl.completionOutput, COMPLETION_OUTPUTS);
  if ("partialBehavior" in decl) inEnum("partialBehavior", decl.partialBehavior, PARTIAL_BEHAVIORS);
  if ("watchdogIdempotency" in decl) inEnum("watchdogIdempotency", decl.watchdogIdempotency, WATCHDOG_IDEMPOTENCY);
  if ("dependencies" in decl) {
    if (!Array.isArray(decl.dependencies)) problems.push("dependencies must be an array");
    else if (knownFamilies) {
      for (const d of decl.dependencies) if (!knownFamilies.has(S(d))) problems.push(`dependency "${S(d)}" is not a declared scheduled family`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * PURE: validate the WHOLE registry + prove every REQUIRED daily family is declared. Returns { ok, problems }.
 */
export function validateScheduledFamilyRegistry(registry = SCHEDULED_FAMILY_REGISTRY) {
  const problems = [];
  const keys = Object.keys(registry);
  const knownFamilies = new Set(keys);
  for (const key of keys) {
    const decl = registry[key];
    if (S(decl && decl.family) !== key) problems.push(`${key}: declaration.family "${S(decl && decl.family)}" != its registry key`);
    const r = validateScheduledFamilyDeclaration(decl, { knownFamilies });
    for (const p of r.problems) problems.push(`${key}: ${p}`);
  }
  for (const req of REQUIRED_DAILY_FAMILIES) {
    if (!knownFamilies.has(req)) problems.push(`REQUIRED daily family "${req}" is not declared (a scheduled family cannot ship undeclared)`);
  }
  return { ok: problems.length === 0, problems };
}
