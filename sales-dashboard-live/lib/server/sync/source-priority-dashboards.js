// Scheduler v2 -- TRUSTED Daily Reporting + Brand View "priority path" (offline-implemented; operator-run).
//
// PURPOSE: bring ONLY Daily Reporting ("daily-reporting") and Brand View ("brand-inventory") live for the
// covered accounts by deriving them from the ALREADY-PROVEN durable OLI history + the organization Catalog,
// WITHOUT a full bucket drain. A normal bucket sync must drain every source (globalDrained) -- trailing OLI
// rolling-refresh + per-account FBA + Ads -- costing dozens of DataDoe creates. This path instead:
//   - runs the bucket runtime in `priority` mode: every non-catalog source is paused, so the run plans ZERO
//     OLI / Ads / FBA / other exports (structurally, not by configuration); the Catalog family is force-planned
//     so a catalog-only cycle drains and the durable-evidence derive/save runs;
//   - the derive reads the durable OLI history (its per-account provenance binds the report lineage) + Catalog,
//     and represents missing Ads (daily runs sales-only) and missing FBA (brand-inventory -> inventoryAvailable
//     false) as UNAVAILABLE via the existing report contracts -- never fabricated;
//   - the create guard here permits ONLY product-catalog creates and caps the WHOLE go-live at ONE Catalog
//     export / 2 tokens (both buckets share one budget; the second bucket reuses the org-scoped catalog cache);
//   - publication is restricted to EXACTLY daily-reporting + brand-inventory (assertPriorityPublishReportKey);
//     every other report stays paused and the scheduler stays disabled (this module never enables either).
//
// It creates no OLI/Ads/FBA exports, requires no unrelated source family to drain, and never publishes any
// other report -- the reviewed, bounded path the go-live authorization asked for.

import { buildBucketSourceSyncRuntime } from "./source-bucket-sync-runtime.js";
import { makeDataDoeAdapter } from "./source-sync-driver.js";

// FROZEN scope. Never overridable from an HTTP body / card action / scheduler.
export const PRIORITY_DASHBOARDS = Object.freeze({
  // The ONLY reports this path derives + publishes. daily-reporting is a Scheduler-v2 dispatch key (gated by
  // report_sync_settings.schedule_enabled); brand-inventory is the source-promoted Brand View (gated by
  // source_promoted_publish_settings.publish_enabled). Both are code-publishable via the reviewed publisher.
  reportKeys: Object.freeze(["daily-reporting", "brand-inventory"]),
  catalogSourceKey: "product-catalog",
  buckets: Object.freeze(["us", "non-us"]),
  maxCatalogCreates: 1,
  maxTokens: 2,
  catalogTokenCost: 2, // one STANDARD Catalog export
});

/**
 * Wrap a DataDoe adapter so it may create ONLY product-catalog exports, at most one, within a hard 2-token
 * ceiling shared across the WHOLE run (`budget` = { creates, tokens }, mutated in place so both buckets share
 * it). ANY OLI/Ads/FBA/other create throws; a second Catalog create or a token overrun throws. poll/download
 * pass through (they spend no tokens). This is defence in depth: `priority` mode already plans zero non-catalog
 * jobs, but the guard makes an out-of-contract create structurally impossible.
 */
export function makePriorityCreateGuard(inner, budget) {
  if (!inner || typeof inner.create !== "function" || typeof inner.poll !== "function" || typeof inner.download !== "function") {
    throw new Error("makePriorityCreateGuard requires an inner adapter exposing create/poll/download (fail closed).");
  }
  if (!budget || typeof budget !== "object") throw new Error("makePriorityCreateGuard requires a shared budget object (fail closed).");
  if (typeof budget.creates !== "number") budget.creates = 0;
  if (typeof budget.tokens !== "number") budget.tokens = 0;
  return {
    create: async (job) => {
      const sk = String((job && job.sourceKey) || "");
      if (sk !== PRIORITY_DASHBOARDS.catalogSourceKey) {
        throw new Error(`PRIORITY_FORBIDDEN_CREATE: the priority dashboards path may create ONLY "${PRIORITY_DASHBOARDS.catalogSourceKey}" exports (got "${sk}"); refusing (fail closed).`);
      }
      const cost = PRIORITY_DASHBOARDS.catalogTokenCost;
      if (budget.creates + 1 > PRIORITY_DASHBOARDS.maxCatalogCreates || budget.tokens + cost > PRIORITY_DASHBOARDS.maxTokens) {
        throw new Error(`PRIORITY_TOKEN_CEILING: creating this Catalog export would exceed the ${PRIORITY_DASHBOARDS.maxCatalogCreates}-create / ${PRIORITY_DASHBOARDS.maxTokens}-token ceiling (spent creates=${budget.creates} tokens=${budget.tokens}); refusing (fail closed).`);
      }
      budget.creates += 1;
      budget.tokens += cost;
      return inner.create(job);
    },
    poll: (...a) => inner.poll(...a),
    download: (...a) => inner.download(...a),
  };
}

/**
 * Build the trusted priority-dashboards derive operation. `buildRuntime(overrides)` builds the REAL bucket
 * runtime (default: buildBucketSourceSyncRuntime); `makeInnerAdapter(connections)` yields the REAL DataDoe
 * adapter (default: makeDataDoeAdapter). Returns { budget, makeDeadline, preflightEvidence, deriveBucket }.
 * deriveBucket(bucket) runs ONE bucket's priority derive (Daily Reporting + Brand View shadow snapshots) off
 * durable OLI + Catalog under the SHARED create budget; run both buckets on the same operation to keep the
 * one-Catalog-export / 2-token ceiling across the whole go-live.
 */
export function buildPriorityDashboardsOperation({
  buildRuntime = buildBucketSourceSyncRuntime,
  makeInnerAdapter = makeDataDoeAdapter,
  budgetMs = 550_000,
  runtimeOverrides = {},
} = {}) {
  if (typeof buildRuntime !== "function") throw new Error("buildPriorityDashboardsOperation requires buildRuntime (fail closed).");
  if (typeof makeInnerAdapter !== "function") throw new Error("buildPriorityDashboardsOperation requires makeInnerAdapter (fail closed).");
  const budget = { creates: 0, tokens: 0 };
  const runtime = buildRuntime({
    ...runtimeOverrides,
    budgetMs,
    makeAdapter: (connections) => makePriorityCreateGuard(makeInnerAdapter(connections), budget),
  });
  return {
    budget,
    makeDeadline: runtime.makeDeadline,
    preflightEvidence: runtime.preflightEvidence,
    async deriveBucket(bucket, { deadline = null, preflight = null } = {}) {
      if (!PRIORITY_DASHBOARDS.buckets.includes(bucket)) {
        throw new Error(`buildPriorityDashboardsOperation.deriveBucket requires bucket in ${PRIORITY_DASHBOARDS.buckets.join("|")} (got "${bucket}") (fail closed).`);
      }
      const rollup = await runtime.run({ bucket, priority: true, deadline, preflight });
      return { rollup, budget: { creates: budget.creates, tokens: budget.tokens } };
    },
  };
}

/**
 * Publisher-side allowlist: the priority path publishes ONLY daily-reporting + brand-inventory. Any other
 * reportKey is refused, so the operator publish loop can never promote an unrelated (paused) report.
 */
export function assertPriorityPublishReportKey(reportKey) {
  const rk = String(reportKey || "");
  if (!PRIORITY_DASHBOARDS.reportKeys.includes(rk)) {
    throw new Error(`PRIORITY_PUBLISH_FORBIDDEN: the priority dashboards path publishes ONLY ${PRIORITY_DASHBOARDS.reportKeys.join(" + ")} (got "${rk}"); refusing (fail closed).`);
  }
  return rk;
}
