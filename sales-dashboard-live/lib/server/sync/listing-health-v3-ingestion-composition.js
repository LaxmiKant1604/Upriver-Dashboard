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
import { getSourceExportCache, saveSourceExportCache, getSourceExportCacheMeta, getRecentSyncCycleIds, getSyncSourceJobsWithMeta, getSyncSourceJobOwnersForCycle, saveSourceSnapshotPayload, recordSourceListingsSnapshot, recordSourceListingsRawSnapshot, isSchemaMissingError, isFunctionSignatureMissingError } from "../supabase.js";
import { organizationFingerprint as orgFingerprintOf } from "../source-identity.js";
import { getDataDoeTokenBalance } from "../datadoe-usage.js";
import { discoverPrimaryAccountIds } from "./priority-control-pg-store.js";
import { buildListingHealthV3Plan, planListingHealthV3IngestionCost } from "./listing-health-v3-operation.js";
import { materializeListingHealthV3PerAccount, LISTING_HEALTH_V3_REGION_EXPORT_CEILING, expectedListingHealthV3NewExports } from "./listing-health-v3-materialize.js";
import { planFbaPlanBucketBatched } from "./report-planner.js";
import { fbaCycleBucket } from "./fba-plan-operation.js";
import { defaultInventoryBatchesOf, overflowSellersFromTruncated, readRecentTruncatedInventoryOwnership, DEFAULT_OVERFLOW_EVIDENCE_MAX_AGE_DAYS } from "./fba-inventory-overflow.js";
import { readRecentReadinessRejectionOwnership, readinessIsolationFrom } from "./source-readiness-isolation.js";

const V3_NEW_SOURCE_KEYS = Object.freeze(["listings", "listings-raw"]);
const V3_INVENTORY_SOURCE_KEY = "fba-inventory-health";

// The dedicated per-region cycle namespace -- NEVER collides with the scheduler-v2 daily (region, cycle_date) cycle.
// `suffix` is an operator-only build seam used by isolated acceptance runs. Production omits it and therefore keeps
// the byte-identical canonical bucket. Acceptance uses the already schema-approved priority-partial namespace; an
// exact 16-hex suffix prevents arbitrary bucket injection and avoids changing the database constraint.
export function listingHealthV3CycleBucket(region, suffix = "") {
  const extra = String(suffix || "").trim();
  if (extra && !/^[0-9a-f]{16}$/.test(extra)) throw new Error("Invalid listing-health-v3 acceptance bucket suffix");
  return extra ? `priority-partial-${String(region)}-${extra}` : `listing-health-v3-${String(region)}`;
}

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
    getSourceJobOwners = getSyncSourceJobOwnersForCycle,
    // WORK B durable-persistence writers (default: the real Supabase functions). ZERO export -- the payload object is
    // content-addressed storage + the pointer is the as_of-dominant CAS RPC. Injectable for offline tests.
    saveDurablePayload = saveSourceSnapshotPayload,
    recordListingsSnapshot = recordSourceListingsSnapshot,
    recordListingsRawSnapshot = recordSourceListingsRawSnapshot,
    cycleBucketSuffix = "",
  } = overrides;

  const cycleBucketFor = (region) => listingHealthV3CycleBucket(region, cycleBucketSuffix);

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
    const primary = (connections || []).find((c) => c && c.id === "primary");
    const org = primary ? (primary.organizationFingerprint || orgFingerprintOf(primary.apiKey)) : null;
    let truncatedOwnership = [];
    try {
      truncatedOwnership = await readRecentTruncatedInventoryOwnership({
        cycleBucket: fbaCycleBucket(region), now, maxAgeDays, connectionId: "primary", organizationFingerprint: org,
        readRecentCycleIds: (cb, since) => getRecentCycleIds(cb, since),
        readSourceJobs: (cid) => getSourceJobsWithMeta(cid),
        readOwners: (cid) => getSourceJobOwners(cid),
      });
    } catch (_e) { return new Set(); }
    const { overflowSellers } = overflowSellersFromTruncated({ defaultInventoryBatches, truncatedOwnership });
    // BATCH-POISONING SELF-HEAL: fold readiness-isolation (DATADOE_INITIAL_LOAD_INCOMPLETE) for the v3 inventory
    // source into the SAME single-seller inventory split channel, so a readiness-poisoned inventory seller is
    // isolated off its shared batch (healthy batch-mates never poisoned; self-clears on the next single-seller
    // success). Fail-soft: any read error adds nothing.
    try {
      // v3 inventory REUSES the fba-plan:inventory-health export identity, so its durable owners carry request_key
      // "fba-plan:inventory-health" under the <region>-fba cycle bucket (exactly what the TRUNCATED reader above
      // matches). Read the SAME shared inventory evidence -- keying on "listing-health-v3:inventory" would match no
      // owner and make the fold inert.
      const { isolateScopeHashes } = await readRecentReadinessRejectionOwnership({
        requestKey: "fba-plan:inventory-health", cycleBucket: fbaCycleBucket(region), now, maxAgeDays, connectionId: "primary", organizationFingerprint: org,
        readRecentCycleIds: (cb, since) => getRecentCycleIds(cb, since),
        readSourceJobs: (cid) => getSourceJobsWithMeta(cid),
        readOwners: (cid) => getSourceJobOwners(cid),
      });
      for (const s of readinessIsolationFrom({ defaultBatches: defaultInventoryBatches, isolateScopeHashes }).isolateSellers) overflowSellers.add(s);
    } catch (_e) { /* fail-soft: no readiness isolation */ }
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
    // WORK B: additively persist the already-validated + per-account-isolated Listings / Listings-Raw fragments to their
    // durable pointer tables (ZERO export). Failure is isolated + typed; migration-unapplied is fail-soft.
    saveDurablePayload,
    recordDurableByKey: { "listing-health-v3:listings": recordListingsSnapshot, "listing-health-v3:listings-raw": recordListingsRawSnapshot },
    isSchemaMissingError,
    isFunctionSignatureMissingError,
  });

  // The frozen NEW-tranche budget (listings + listings-raw ONLY; inventory is never in it), computed WITHOUT persisting.
  // The operation binds the standing authorization to exactly this (fingerprint + hashes + ceilings) BEFORE paid work.
  const newTranche = (region) => makeSourceTranche({ sourceKeys: [...V3_NEW_SOURCE_KEYS], name: `lhv3-new#${region}` });
  const freezeBudget = ({ plan, region }) => {
    const plannedJobs = resolveFromGenericPlan(plan)().sourceJobs;
    return computeFrozenTrancheBudget({ plannedJobs, sourceTranche: newTranche(region), isPremiumOf: budgetPlanner.isPremiumOf, trancheKey: `lhv3-new#${region}` });
  };
  // The DURABLE frozen budget already on this region's v3 cycle for the tranche (null = no cycle/budget yet = a NEW
  // frozen cycle). Read-only; a read failure propagates so the operation defers typed (frozen-budget-unreadable).
  const readFrozenBudget = async ({ region, cycleDate, trancheKey }) => {
    const cyc = await runtime.store.getCycleByBucketDate(cycleBucketFor(region), cycleDate);
    if (!cyc || !cyc.id) return null;
    if (typeof runtime.store.getBudget !== "function" || typeof runtime.store.getBudgetHashes !== "function") throw new Error("frozen-budget readers unavailable on the store");
    const row = await runtime.store.getBudget({ cycleId: cyc.id, trancheKey });
    if (!row) return null;
    const hashes = await runtime.store.getBudgetHashes({ cycleId: cyc.id, trancheKey });
    return { cycleId: cyc.id, row, hashes: Array.isArray(hashes) ? hashes : [] };
  };

  const runSources = async ({ plan, region, cycleDate, authorizationBinding = null }) => {
    const cycleBucket = cycleBucketFor(region);
    const NEW = newTranche(region);
    const INV = makeSourceTranche({ sourceKeys: [V3_INVENTORY_SOURCE_KEY], name: `lhv3-inv#${region}` });
    // Freeze the create budget for the NEW tranche ONLY (listings + listings-raw). Inventory is never in it.
    const plannedJobs = resolveFromGenericPlan(plan)().sourceJobs;
    const frozen = freezeBudget({ plan, region });
    // EXACT BINDING ENFORCEMENT (fail closed BEFORE openCycle/persistBudget/reservation/POST): the operation's bound
    // authorization must describe EXACTLY this region, cycle, tranche, plan fingerprint, ceilings and request hashes.
    if (!authorizationBinding || !authorizationBinding.bindingHash) {
      throw new Error("listing-health-v3 ingestion: AUTHORIZATION_BINDING_MISSING -- runSources requires the operation's exact authorization binding; refusing before any cycle/reservation/POST (fail closed).");
    }
    const b = authorizationBinding;
    const mismatches = [];
    if (String(b.region) !== String(region)) mismatches.push("region");
    if (String(b.cycleDate) !== String(cycleDate)) mismatches.push("cycleDate");
    if (String(b.trancheKey) !== String(frozen.trancheKey)) mismatches.push("trancheKey");
    if (String(b.planFingerprint) !== String(frozen.planFingerprint)) mismatches.push("planFingerprint");
    if (Number(b.maxCreates) !== frozen.maxCreates || Number(b.maxTokens) !== frozen.maxTokens) mismatches.push("ceilings");
    if (JSON.stringify([...(b.requestHashes || [])]) !== JSON.stringify(frozen.hashes.map((h) => h.requestHash).sort())) mismatches.push("requestHashes");
    if (mismatches.length) {
      throw new Error(`listing-health-v3 ingestion: AUTHORIZATION_BINDING_MISMATCH (${mismatches.join(", ")}) -- refusing before any cycle/reservation/POST (fail closed).`);
    }
    // STRUCTURAL DRIFT GUARD (P1): the frozen NEW-create count must equal the exact expected 2-per-<=5-seller-batch
    // count for the plan's distinct accounts. A plan fanning out MORE creates than the membership justifies is drift
    // and fails closed. This is NOT the obsolete fixed 4/8/4 assumption (removed): the AUTHORIZED spending limit is
    // the frozen tranche budget's maxCreates + the atomic pre-POST reservation + the runner's DataDoe balance gate.
    const acctIds = new Set();
    for (const j of plannedJobs || []) {
      const ids = Array.isArray(j && j.sellerOrVendorIds) ? j.sellerOrVendorIds
        : (j && j.owner ? [j.owner.accountId ?? j.owner.rawSellerId]
          : [j && (j.accountId ?? j.rawSellerId)]);
      for (const id of ids) { const s = String(id ?? "").trim(); if (s) acctIds.add(s); }
    }
    const expectedNew = expectedListingHealthV3NewExports(acctIds.size);
    // Only drift-fail when the account count is DETERMINABLE (size>0); an indeterminate count is bounded by the
    // frozen tranche budget + the atomic pre-POST reservation, never a fabricated 0-expectation that would refuse
    // a legitimate plan.
    if (expectedNew != null && acctIds.size > 0 && frozen.maxCreates > expectedNew) {
      throw new Error(`listing-health-v3 ingestion: frozen create count ${frozen.maxCreates} exceeds the structural expectation ${expectedNew} (2 x ceil(${acctIds.size} accounts / 5)) -- drift, fail closed.`);
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
    // Pass 2: inventory REUSE-ONLY (adopt the current FBA Plan cache; never a v3 create). OPTIONAL-INVENTORY:
    // completeUnavailableOnMissingReuse marks an account with no adoptable FBA inventory cache COMPLETE-AS-UNAVAILABLE
    // (terminal 'skipped') instead of leaving a blocking pending job, so the dedicated cycle DRAINS + finalizes
    // 'succeeded' for the accounts whose required listings/OLI published while inventory stays unavailable for the
    // FBA-failed accounts. This flag is set ONLY on the INV pass (Pass 1 NEW listings stays fail-closed on a miss).
    const p2 = await runSourceCycle({
      store: runtime.store, dataDoe: runtime.dataDoe, resolvePlan: resolveFromGenericPlan(plan),
      bucket: region, cycleBucket, cycleDate, trigger: "manual", deadlineMs: Infinity, reserveMs: 0,
      sourceTranche: INV, reuseOnly: true, completeUnavailableOnMissingReuse: true, budget: null,
    });

    // Actual creates = NEW-tranche jobs whose create_export_count > 0 (honest evidence, not the reserved ceiling).
    const jobs = await runtime.store.listSourceJobs(p1.cycleId || cycleId);
    const newHashes = new Set(frozen.hashes.map((h) => h.requestHash));
    const invSourceKey = V3_INVENTORY_SOURCE_KEY;
    const createdNewJobs = jobs.filter((j) => newHashes.has(j.request_hash ?? j.requestHash) && Number(j.create_export_count ?? j.createExportCount ?? 0) > 0);
    const creates = createdNewJobs.length;
    // Observed tokens priced by the SAME per-source token class the frozen budget froze (frozen.hashes[].tokenCost:
    // premium listings=5 / standard listings-raw=2), NOT a flat creates*2 -- so the reported spend cannot understate a
    // premium create. rowCountBilling=true means each per-source price is still an estimate; the true charge is the
    // reserved frozen budget.
    const tokenCostByHash = new Map(frozen.hashes.map((h) => [h.requestHash, Number(h.tokenCost) || 0]));
    const tokens = createdNewJobs.reduce((sum, j) => sum + (tokenCostByHash.get(j.request_hash ?? j.requestHash) || 0), 0);
    const inventoryCreated = jobs.some((j) => (j.source_key ?? j.sourceKey) === invSourceKey && Number(j.create_export_count ?? j.createExportCount ?? 0) > 0);
    return {
      cycleId: p1.cycleId || cycleId,
      drained: !!(p1.drained && p2.drained),
      creates, maxCreates: frozen.maxCreates, tokens, // observed estimate (rowCountBilling=true), real per-source pricing
      inventoryCreated, inventoryPass: { succeeded: p2.succeeded, skipped: p2.skipped }, newPass: { succeeded: p1.succeeded, failed: p1.failed },
    };
  };

  const runReports = async ({ plan, region, cycleDate }) => {
    const cycleBucket = cycleBucketFor(region);
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
    const cycleBucket = cycleBucketFor(region);
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
    freezeBudget, readFrozenBudget,
    getSourceExportCache: getExportCache,
    reservationSupported: typeof runtime.store.reserveExportCreate === "function",
    pricingKnown: true,
  });
}
