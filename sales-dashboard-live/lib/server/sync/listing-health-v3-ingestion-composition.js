// TRUSTED production wiring for the Listing Health v3 dedicated ingestion operator (Phase 4B2). The ONE place the
// reviewed production collaborators are bound to the pure operator core (listing-health-v3-operation.js), mirroring
// buildFbaPlanRelease. It reuses the EXACT established machinery -- buildSchedulerV2Runtime (store + DataDoe adapter +
// shadow snapshot saver + derived-context loaders), resolveFromGenericPlan (the live dispatcher's plan->owned-jobs
// mapping), runStagedSourceCycle (the resumable source worker), runReportJobs (the report worker),
// materializeListingHealthV3PerAccount, the frozen tranche budget + atomic create reservation, and the read-only
// DataDoe balance -- so this path can NEVER drift from the scheduler and duplicates NO worker logic. Construction
// performs NO I/O; every collaborator is injectable so the composition is offline-testable. It is NOT wired to any
// api route / cron / watchdog, and the operator core still requires an explicit authorization + the default-disabled
// ingestion gate before any live run.
//
// SOURCE EXECUTION is a deliberate TWO-PASS split so inventory is REUSE-ONLY:
//   Pass 1 (create): a source tranche selecting ONLY listings + listings-raw, under the FROZEN per-region budget
//     (atomic pre-POST reservation) -- so at most `maxCreates` (<= the region ceiling) creates ever POST.
//   Pass 2 (reuse-only): a source tranche selecting ONLY fba-inventory-health with reuseOnly=true -- it ADOPTS the
//     current FBA Plan inventory cache (zero create) or returns MISSING_REUSABLE_SOURCE; it can NEVER create a v3
//     inventory export. OLI + Catalog are DERIVED durable dependencies (zero exports), injected at report-derive time.

import { buildSchedulerV2Runtime, makeProductionDiscoverAccounts } from "./runtime-composition.js";
import { runStagedSourceCycle } from "./source-sync-driver.js";
import { resolveFromGenericPlan } from "./sync-dispatch.js";
import { runReportJobs } from "./report-worker.js";
import { makeSourceTranche } from "./source-tranche.js";
import { computeFrozenTrancheBudget } from "./source-tranche-budget.js";
import { registryBudgetPlanner } from "./source-fixpoint.js";
import { getDataDoeConnections } from "../datadoe-connections.js";
import { getSourceExportCache, saveSourceExportCache, getSourceExportCacheMeta, getRecentSyncCycleIds, getSyncSourceJobsWithMeta } from "../supabase.js";
import { getDataDoeTokenBalance } from "../datadoe-usage.js";
import { discoverPrimaryAccountIds } from "./priority-control-pg-store.js";
import { buildListingHealthV3Plan, planListingHealthV3IngestionCost } from "./listing-health-v3-operation.js";
import { materializeListingHealthV3PerAccount, LISTING_HEALTH_V3_REGION_EXPORT_CEILING } from "./listing-health-v3-materialize.js";
import { planFbaPlanBucketBatched } from "./report-planner.js";
import { fbaCycleBucket } from "./fba-plan-operation.js";
import { defaultInventoryBatchesOf, overflowSellersFromTruncated, readRecentTruncatedInventoryHashes, DEFAULT_OVERFLOW_EVIDENCE_MAX_AGE_DAYS } from "./fba-inventory-overflow.js";

const V3_NEW_SOURCE_KEYS = Object.freeze(["listings", "listings-raw"]);
const V3_INVENTORY_SOURCE_KEY = "fba-inventory-health";

// The dedicated per-region cycle namespace -- NEVER collides with the scheduler-v2 daily (region, cycle_date) cycle.
export function listingHealthV3CycleBucket(region) { return `listing-health-v3-${String(region)}`; }

/**
 * Build the trusted v3 ingestion collaborators the operator core consumes. `overrides` is a BUILD-TIME test seam
 * only (production passes just { operator }). Returns { discoverAccounts, buildPlan, resolveCost, checkBalance,
 * runSources, materialize, runReports, reservationSupported, pricingKnown, connections, operator }.
 */
export function buildListingHealthV3IngestionRelease(overrides = {}) {
  const {
    operator = "operator",
    makeRuntime = buildSchedulerV2Runtime,
    getConnections = getDataDoeConnections,
    discoverAccountIds = discoverPrimaryAccountIds,
    readDirectoryAccounts = null,
    getExportCache = getSourceExportCache,
    saveExportCache = saveSourceExportCache,
    getExportCacheMeta = getSourceExportCacheMeta,
    getTokenBalance = getDataDoeTokenBalance,
    budgetPlanner = registryBudgetPlanner(),
    runSourceCycle = runStagedSourceCycle,
    runReportsFn = runReportJobs,
    materializeFn = materializeListingHealthV3PerAccount,
    regionCeilings = LISTING_HEALTH_V3_REGION_EXPORT_CEILING,
    // Injectable durable evidence readers for the inventory-only overflow derivation (default: the real Supabase
    // readers). A build-time test seam ONLY -- kept injectable so the composition stays offline-testable.
    getRecentCycleIds = getRecentSyncCycleIds,
    getSourceJobsWithMeta = getSyncSourceJobsWithMeta,
  } = overrides;

  const runtime = makeRuntime({}); // store + dataDoe + saveSnapshot + loadDerivedContext (shadow namespace)
  const connections = getConnections();
  const primaryApiKey = (connections.find((c) => c && c.id === "primary") || {}).apiKey || null;

  // Authoritative primary account directory (a fresh accounts GET -- never an export), intersected with the
  // authoritative primary id discovery. dd-secondary/prefixed ids + accounts without a marketplace country are
  // dropped (they can never be batched/bucketed safely).
  const discoverAccounts = async () => {
    const readAccounts = readDirectoryAccounts || makeProductionDiscoverAccounts({ connections: getConnections });
    const rows = (await readAccounts()) || [];
    const metaById = new Map();
    for (const r of rows) {
      const id = String((r && (r.accountId || r.account_id || r.id)) || "").trim();
      const country = String((r && (r.country || r.marketplace_country_code)) || "").trim();
      if (!id || id.includes(":") || !country) continue;
      metaById.set(id, { accountId: id, country, currency: (r && r.currency) || null, name: (r && r.name) || null });
    }
    const primaryIds = await discoverAccountIds();
    return primaryIds.map((id) => metaById.get(id)).filter(Boolean);
  };

  const resolveCost = ({ plan }) => planListingHealthV3IngestionCost({ plan, getSourceExportCache: getExportCache });

  // Derive the INVENTORY-ONLY overflow split from the SAME proven terminal-TRUNCATED evidence the FBA plan uses (the
  // region's `<region>-fba` cycle), so a v3 inventory read hash matches the FBA single-seller child recovered for a
  // whale seller. This is the ONLY way an overflow account's inventory is adoptable with zero new inventory exports.
  // Fails soft to an empty set (no split => default batching) -- it never blocks planning. Listings/Listings-Raw are
  // unaffected (the planner splits inventory only).
  const resolveInventoryOverflowSellers = async ({ accounts, cycleDate, region, maxAgeDays = DEFAULT_OVERFLOW_EVIDENCE_MAX_AGE_DAYS, now = () => Date.now() }) => {
    if (!accounts || !accounts.length) return new Set();
    let defaultInventoryBatches = [];
    try {
      const fbaPlan = planFbaPlanBucketBatched({ accounts, connections, asOfFor: () => cycleDate, inventoryAsOf: cycleDate });
      defaultInventoryBatches = defaultInventoryBatchesOf(fbaPlan);
    } catch (_e) { return new Set(); }
    let recentTruncatedHashes = new Set();
    try {
      recentTruncatedHashes = await readRecentTruncatedInventoryHashes({
        cycleBucket: fbaCycleBucket(region), now, maxAgeDays,
        readRecentCycleIds: (cb, since) => getRecentCycleIds(cb, since),
        readSourceJobs: (cid) => getSourceJobsWithMeta(cid),
      });
    } catch (_e) { return new Set(); }
    const { overflowSellers } = overflowSellersFromTruncated({ defaultInventoryBatches, recentTruncatedHashes });
    return overflowSellers;
  };

  // Production plan builder: derive the inventory-only overflow split, then build the frozen v3 plan with it. buildPlan
  // is awaited by the operator, so returning a Promise is fine. `region` is required to scope the FBA overflow evidence.
  const buildPlan = async ({ accounts, connections: conns, cycleDate, region }) => {
    const overflowSellers = await resolveInventoryOverflowSellers({ accounts, cycleDate, region });
    return buildListingHealthV3Plan({ accounts, connections: conns || connections, cycleDate, overflowSellers });
  };

  const checkBalance = async () => {
    if (!primaryApiKey) return { usable: null };
    const bal = await getTokenBalance({ apiKey: primaryApiKey });
    return { usable: bal && bal.read === "ok" ? bal.usable : null };
  };

  const materialize = ({ plans, connections: conns }) => materializeFn({
    plans, connections: conns || connections,
    readSourceCache: getExportCache,
    writeSourceCache: saveExportCache,
    readAliasMeta: async (h) => { const e = await getExportCacheMeta(h); return e && e.request_meta ? { batchFetchedAt: e.request_meta.batchFetchedAt } : null; },
  });

  const runSources = async ({ plan, region, cycleDate }) => {
    const cycleBucket = listingHealthV3CycleBucket(region);
    const ceiling = regionCeilings[region];
    const NEW = makeSourceTranche({ sourceKeys: [...V3_NEW_SOURCE_KEYS], name: `lhv3-new#${region}` });
    const INV = makeSourceTranche({ sourceKeys: [V3_INVENTORY_SOURCE_KEY], name: `lhv3-inv#${region}` });
    // Freeze the create budget for the NEW tranche ONLY (listings + listings-raw). Inventory is never in it.
    const plannedJobs = resolveFromGenericPlan(plan)().sourceJobs;
    const frozen = computeFrozenTrancheBudget({ plannedJobs, sourceTranche: NEW, isPremiumOf: budgetPlanner.isPremiumOf, trancheKey: `lhv3-new#${region}` });
    if (typeof ceiling !== "number" || frozen.maxCreates > ceiling) {
      throw new Error(`listing-health-v3 ingestion: frozen create count ${frozen.maxCreates} exceeds region "${region}" ceiling ${ceiling}; refusing (fail closed).`);
    }
    // Persist the frozen budget on the namespaced cycle BEFORE any create (idempotent).
    const cycleId = await runtime.store.openCycle({ bucket: cycleBucket, cycleDate, trigger: "manual" });
    const ack = await runtime.store.persistBudget({
      cycleId, trancheKey: frozen.trancheKey, planFingerprint: frozen.planFingerprint,
      maxCreates: frozen.maxCreates, maxTokens: frozen.maxTokens,
      hashes: frozen.hashes.map((h) => ({ requestHash: h.requestHash, tokenCost: h.tokenCost })),
    });
    if (ack !== "created" && ack !== "exists") throw new Error(`listing-health-v3 ingestion: persistBudget returned "${ack}"; refusing (fail closed).`);
    const budget = { trancheKey: frozen.trancheKey, planFingerprint: frozen.planFingerprint };

    // Pass 1: create listings + listings-raw within the frozen budget (atomic pre-POST reservation).
    const p1 = await runSourceCycle({
      store: runtime.store, dataDoe: runtime.dataDoe, resolvePlan: resolveFromGenericPlan(plan),
      bucket: region, cycleBucket, cycleDate, trigger: "manual", deadlineMs: Infinity, reserveMs: 0,
      sourceTranche: NEW, reuseOnly: false, budget,
    });
    // Pass 2: inventory REUSE-ONLY (adopt the current FBA Plan cache; never a v3 create).
    const p2 = await runSourceCycle({
      store: runtime.store, dataDoe: runtime.dataDoe, resolvePlan: resolveFromGenericPlan(plan),
      bucket: region, cycleBucket, cycleDate, trigger: "manual", deadlineMs: Infinity, reserveMs: 0,
      sourceTranche: INV, reuseOnly: true, budget: null,
    });

    // Actual creates = NEW-tranche jobs whose create_export_count > 0 (honest evidence, not the reserved ceiling).
    const jobs = await runtime.store.listSourceJobs(p1.cycleId || cycleId);
    const newHashes = new Set(frozen.hashes.map((h) => h.requestHash));
    const invSourceKey = V3_INVENTORY_SOURCE_KEY;
    const creates = jobs.filter((j) => newHashes.has(j.request_hash ?? j.requestHash) && Number(j.create_export_count ?? j.createExportCount ?? 0) > 0).length;
    const inventoryCreated = jobs.some((j) => (j.source_key ?? j.sourceKey) === invSourceKey && Number(j.create_export_count ?? j.createExportCount ?? 0) > 0);
    return {
      cycleId: p1.cycleId || cycleId,
      drained: !!(p1.drained && p2.drained),
      creates, maxCreates: frozen.maxCreates, tokens: creates * 2, // observed estimate (rowCountBilling=true)
      inventoryCreated, inventoryPass: { succeeded: p2.succeeded, skipped: p2.skipped }, newPass: { succeeded: p1.succeeded, failed: p1.failed },
    };
  };

  const runReports = async ({ plan, region, cycleDate }) => {
    const cycleBucket = listingHealthV3CycleBucket(region);
    const cyc = await runtime.store.getCycleByBucketDate(cycleBucket, cycleDate);
    const cycleId = cyc && cyc.id;
    if (!cycleId) return { succeeded: 0, note: "no-cycle" };
    const res = await runReportsFn({
      store: runtime.store, cycleId,
      sourceRows: (h) => runtime.store.loadSourceRows(h),
      saveSnapshot: runtime.saveSnapshot,
      plannedReports: (plan.reportRequests || []).filter((r) => r && r.reportKey === "listing-health-v3"),
      loadDerivedContext: runtime.loadDerivedContext,
      deadlineMs: Infinity, reserveMs: 0,
    });
    return { succeeded: res.succeeded || 0, blocked: res.blocked || 0, failed: res.failed || 0, drained: !!res.drained };
  };

  // Guarded finalization of the dedicated listing-health-v3-<region> cycle -> the reviewed finalize_sync_cycle RPC via
  // runtime.store.finalizeCycle. Returns a TYPED, replay-safe result: { disposition, status, cycleId }. `succeeded`
  // (no source/report failures) is the ONLY full success; `partial`/`failed`/`open-work`/`not-found`/`invalid-status`
  // are honest non-successes. An already-terminal succeeded cycle (a watchdog replay) returns disposition
  // 'already-terminal' + status 'succeeded' -- a zero-create idempotent success.
  const finalizeCycle = async ({ region, cycleDate }) => {
    const cycleBucket = listingHealthV3CycleBucket(region);
    const cyc = await runtime.store.getCycleByBucketDate(cycleBucket, cycleDate);
    const cycleId = cyc && cyc.id;
    if (!cycleId) return { disposition: "not-found", status: null, cycleId: null };
    const disp = await runtime.store.finalizeCycle({ cycleId });
    return { disposition: disp && disp.disposition, status: disp && disp.cycle ? disp.cycle.status : null, cycleId };
  };

  return Object.freeze({
    operator, connections, runtime,
    discoverAccounts,
    buildPlan,
    resolveCost, checkBalance, materialize, runSources, runReports, finalizeCycle,
    getSourceExportCache: getExportCache,
    reservationSupported: typeof runtime.store.reserveExportCreate === "function",
    pricingKnown: true,
  });
}
