// TRUSTED production wiring for the FBA Shipment Plan operation -- the ONE place the reviewed collaborators are
// bound to the pure fba-plan operation core (fba-plan-operation.js). Mirrors buildPriorityDashboardsRelease for
// the OLI/priority path: the CLI operator, the automatic GitHub scheduler, and the Data Sync Center route all
// call buildFbaPlanRelease() + advanceFbaPlanBucket() so no execution path can drift, and NO api/ route wires the
// publisher composition, the CAS primitive, or the control internals itself -- it reaches them ONLY through this
// reviewed release seam (which opens the guarded fba-plan control package, publishes through the four durable
// gates + freshness CAS, reads back each live snapshot by its exact identity, and ALWAYS safe-closes).
//
// Construction performs NO I/O; every collaborator is injectable so the composition is offline-testable.

import { buildSchedulerV2Runtime, makeProductionDiscoverAccounts } from "./runtime-composition.js";
import { buildSchedulerV2Publisher } from "./publisher-composition.js";
import { planFbaPlanBucketBatched } from "./report-planner.js";
import { fbaCycleBucket } from "./fba-plan-operation.js";
import { defaultInventoryBatchesOf, overflowSellersFromTruncated, readRecentTruncatedInventoryHashes, DEFAULT_OVERFLOW_EVIDENCE_MAX_AGE_DAYS } from "./fba-inventory-overflow.js";
import { getRecentSyncCycleIds, getSyncSourceJobsWithMeta } from "../supabase.js";
import { runControlPackageCli, buildFbaPlanControlPackage } from "./source-priority-control-package.js";
import { CONTROLLED_REPORT_KEYS } from "./report-controls.js";
import { buildLiveReadback } from "./source-priority-release-runner.js";
import { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } from "./report-publisher.js";
import { REPORT_DERIVATIONS } from "./report-derivation.js";
import { paramsHashFor } from "../report-store.js";
import {
  getReportSnapshot, getReportSnapshotStoragePayload,
  getSourceCoverageWindows, getSourceExportCache,
} from "../supabase.js";
import { getDataDoeConnections, resolveDataDoeAccountIds } from "../datadoe-connections.js";
import { discoverPrimaryAccountIds, connectPriorityControlStore } from "./priority-control-pg-store.js";

/**
 * Build the trusted fba-plan release collaborators. `overrides` is a BUILD-TIME test seam only (production callers
 * pass just { operator }). Returns the wired collaborators advanceFbaPlanBucket consumes, plus the shared readers
 * (connections + coverage/cache) and a directory loader so every path resolves the SAME account scope + as-of.
 *
 * The control envelope: apply enables ONLY the fba-plan publication gates (GATE2 dispatch + GATE3 rollout + GATE4
 * approvals, no promoted); close (rollback) safe-closes every controlled report key. Both are idempotent.
 */
export function buildFbaPlanRelease(overrides = {}) {
  const {
    operator = "operator",
    makeRuntime = buildSchedulerV2Runtime,
    makePublisher = buildSchedulerV2Publisher,
    runControlPackage = runControlPackageCli,
    buildApplyPackage = buildFbaPlanControlPackage,
    controlledReportKeys = CONTROLLED_REPORT_KEYS,
    makeReadback = buildLiveReadback,
    liveContracts = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
    reportDerivations = REPORT_DERIVATIONS,
    computeHash = paramsHashFor,
    readReportSnapshot = getReportSnapshot,
    loadStoragePayload = getReportSnapshotStoragePayload,
    // Production uses the same fresh accounts GET as the runtime. A saved directory can omit newly connected sellers.
    readDirectoryAccounts = null,
    discoverAccounts = discoverPrimaryAccountIds,
    connectStore = connectPriorityControlStore,
    getConnections = getDataDoeConnections,
    resolveAccountIds = resolveDataDoeAccountIds,
    readCoverage = getSourceCoverageWindows,
    readExportCache = getSourceExportCache,
    ownershipModulePath = "../../../scripts/backfill-fba-ownership.mjs",
  } = overrides;

  const runtime = makeRuntime({});
  const publisher = makePublisher();
  const readbackLive = makeReadback({ getReportSnapshot: readReportSnapshot, loadStoragePayload, liveContracts, reportDerivations, computeHash });
  const controls = {
    apply: async () => {
      const r = await runControlPackage({ mode: "apply", operator, discoverAccounts, connectStore, controlledReportKeys, buildApplyPackage });
      if (!r || r.committed !== true) throw new Error("controls apply did not commit (code " + (r && r.code) + ")");
    },
    close: async () => {
      const r = await runControlPackage({ mode: "rollback", operator, connectStore, controlledReportKeys });
      if (!r || r.committed !== true) throw new Error("SAFE-CLOSE did not commit (code " + (r && r.code) + ") -- verify controls manually");
    },
  };
  const ownershipBackfill = async () => {
    const mod = await import(ownershipModulePath);
    return mod.backfillFbaOwnership({ dry: false });
  };

  // Load current account metadata, not a stale snapshot. Discovery is a read-only accounts GET, never an export.
  // dd-secondary/public-prefixed ids + accounts without a marketplace country are excluded (they can never be
  // batched or bucketed safely). Intersected with the fresh authoritative primary discovery.
  const loadAccounts = async () => {
    const readAccounts = readDirectoryAccounts || makeProductionDiscoverAccounts({ connections: getConnections });
    const rows = (await readAccounts()) || [];
    const metaById = new Map();
    for (const r of rows) {
      const id = String((r && (r.accountId || r.account_id || r.id)) || "").trim();
      const country = String((r && (r.country || r.marketplace_country_code)) || "").trim();
      if (!id || id.includes(":") || !country) continue;
      metaById.set(id, { accountId: id, country, currency: (r && r.currency) || null, name: (r && r.name) || null });
    }
    const primaryIds = await discoverAccounts();
    return primaryIds.map((id) => metaById.get(id)).filter(Boolean);
  };

  // Adaptive FBA-inventory self-heal: derive the proven-overflow raw seller ids for a bucket from recent terminal
  // TRUNCATED inventory evidence (scoped to the region-fba cycle bucket + a recency window). The default plan maps a
  // recent TRUNCATED batch hash deterministically back to its sellers. Fail-soft: any read error yields an empty set
  // (byte-identical default batching). Also returns single-seller HARD STOPS (a lone seller still at the 50000 cap
  // that cannot split further -- the caller escalates, never auto-raises the limit).
  const resolveOverflowSellers = async ({ bucket, bucketAccounts, asOf, inventoryAsOf, maxAgeDays = DEFAULT_OVERFLOW_EVIDENCE_MAX_AGE_DAYS, now = () => Date.now() }) => {
    if (!bucketAccounts || !bucketAccounts.length) return { overflowSellers: new Set(), singleSellerHardStops: [] };
    let defaultInventoryBatches = [];
    try {
      const plan = planFbaPlanBucketBatched({ accounts: bucketAccounts, connections: getConnections(), asOfFor: () => asOf, inventoryAsOf });
      defaultInventoryBatches = defaultInventoryBatchesOf(plan);
    } catch (_e) { return { overflowSellers: new Set(), singleSellerHardStops: [] }; }
    const recentTruncatedHashes = await readRecentTruncatedInventoryHashes({
      cycleBucket: fbaCycleBucket(bucket), now, maxAgeDays,
      readRecentCycleIds: (cb, since) => getRecentSyncCycleIds(cb, since),
      readSourceJobs: (cid) => getSyncSourceJobsWithMeta(cid),
    });
    return overflowSellersFromTruncated({ defaultInventoryBatches, recentTruncatedHashes });
  };

  return Object.freeze({
    runtime, publisher, controls, readbackLive, ownershipBackfill,
    loadAccounts, resolveOverflowSellers,
    connections: getConnections(),
    scopeReaders: { resolveDataDoeAccountIds: resolveAccountIds, getSourceCoverageWindows: readCoverage },
    getSourceExportCache: readExportCache,
    operator,
  });
}
