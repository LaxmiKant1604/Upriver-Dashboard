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

const S = (v) => (v == null ? "" : String(v));

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
    // Round-7 blocker 1: the control-plane owner-lease token (+ operation key). Threaded into every control
    // apply/close so the pg store's lease serializes this FBA operation against concurrent regional/route/manual
    // operations. Blank => the lease-capable pg store fails closed (no un-leased global reconcile/safe-close).
    ownerToken = "",
    controlOperationKey = "",
    // Round-8 blocker 1: the lease TTL (seconds) used by apply/renew. The publish heartbeat renews well within it.
    leaseTtlSeconds = 900,
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
    // TRUSTED, BUILD-TIME account-scope override (Round-6 blocker 1). When a non-empty array of EXACT public
    // ids is supplied (a scoped bootstrap FBA go-live passes its frozenAccountIds), the WHOLE release is
    // constrained to exactly those accounts: (a) the runtime's durable account-rollout is replaced with a
    // frozen allowlist, so the dispatcher's rollout FILTER (applied before any cycle/source planning) scopes
    // discovery -> source planning -> fetching -> deriving to exactly the frozen set; (b) the control package's
    // discovery + the ownership backfill's account list are the frozen set, so no control mutation or ownership
    // write touches an outside-wave account; (c) the directory loader returns only frozen accounts. null/empty
    // => byte-identical natural full-region behavior (no rollout override, discovery = full-region).
    accountScopeIds = null,
  } = overrides;

  const scoped = Array.isArray(accountScopeIds) && accountScopeIds.length > 0
    ? [...new Set(accountScopeIds.map((x) => String(x).trim()).filter(Boolean))]
    : null;
  const scopedDiscoverAccounts = scoped ? (async () => [...scoped]) : discoverAccounts;

  // Scoped runtime: a frozen rollout allowlist makes the dispatcher's Gate-7 rollout filter select EXACTLY
  // the frozen accounts on every dispatch (source + derive + publish), immune to the global durable rollout.
  const runtime = scoped
    ? makeRuntime({ getAccountRollout: async () => ({ read: "ok", allPrimary: false, enabledAccountIds: [...scoped] }) })
    : makeRuntime({});
  // Round-8/9 blocker 1: the FENCE captured at apply (owner_token + generation). The publish WRITE fences THIS
  // exact fence inside the report_snapshots CAS (Round-9 P0-A), and the publish path also heartbeats it before
  // each chunk. Declared BEFORE the publisher so getControlFence reads the CURRENT (mutable) captured fence.
  let leaseFence = null;
  // Round-9 P0-A + property 5: this is a CONTROL-ENABLED (Gate-7) publisher, so it is built WITH getControlFence
  // -- every live write goes through the FENCED CAS and FAILS CLOSED (lease-lost) when no live fence is captured.
  const publisher = makePublisher({ getControlFence: () => leaseFence });
  const readbackLive = makeReadback({ getReportSnapshot: readReportSnapshot, loadStoragePayload, liveContracts, reportDerivations, computeHash });
  const controls = {
    apply: async () => {
      // Control discovery is the FROZEN set in scoped mode: the apply opens the publication rollout/approvals
      // for EXACTLY the frozen accounts (the exact-set reconcile leaves every OTHER account's transient
      // controls untouched -- snapshots are never touched -- so no outside-wave control mutation occurs).
      const r = await runControlPackage({ mode: "apply", operator, discoverAccounts: scopedDiscoverAccounts, connectStore, controlledReportKeys, buildApplyPackage, ownerToken, operationKey: controlOperationKey, leaseTtlSeconds });
      if (!r || r.committed !== true) throw new Error("controls apply did not commit (code " + (r && r.code) + ")" + (r && r.problem ? ": " + r.problem : ""));
      // Round-10 (blocker 6): a lease-capable apply MUST return a VALID fencing generation IMMEDIATELY -- never
      // continue with a null/invalid fence and discover it only at the first snapshot write. Fail closed here.
      if (S(ownerToken).trim()) {
        const gen = Number(r.leaseGeneration);
        if (!(Number.isSafeInteger(gen) && gen > 0)) throw new Error("controls apply did not return a valid fencing generation (" + S(r.leaseGeneration) + ") -- refusing to publish (fail closed).");
        leaseFence = { ownerToken: r.ownerToken || ownerToken, generation: gen };
      }
    },
    close: async () => {
      // Round-9 P1-C: pass the captured fence GENERATION so a superseded generation can never close/release a
      // newer lease.
      const r = await runControlPackage({ mode: "rollback", operator, connectStore, controlledReportKeys, ownerToken, ownerGeneration: leaseFence ? leaseFence.generation : null, operationKey: controlOperationKey });
      // A lease-not-owner skip is a CORRECT no-op (this operation lost/never held the lease -> it closes nothing);
      // it must NOT throw here (the operation already stopped publishing). Any other non-commit is a real error.
      if (r && r.skipped === "lease-not-owner") { leaseFence = null; return; }
      if (!r || r.committed !== true) throw new Error("SAFE-CLOSE did not commit (code " + (r && r.code) + ") -- verify controls manually");
      leaseFence = null;
    },
  };
  // The publish-path HEARTBEAT (blocker 1): renew the captured fence via a standalone connection. Returns
  // { ok:true } when this operation still holds the exact fence (renewed), else { ok:false, reason } (lost/error)
  // so the caller stops immediately, publishes nothing further, and returns a typed retryable contention result.
  // A no-fence (natural/no-lease) or non-lease-capable store is a no-op ok:true (byte-identical natural behavior).
  const verifyLease = async () => {
    if (!leaseFence || !S(leaseFence.ownerToken).trim()) return { ok: true, reason: "no-fence" };
    let store;
    try {
      store = await connectStore();
      if (typeof store.renewControlLease !== "function") return { ok: true, reason: "not-lease-capable" };
      const r = await store.renewControlLease(leaseFence.ownerToken, leaseFence.generation, leaseTtlSeconds);
      return { ok: !!(r && r.disposition === "renewed"), reason: r && r.reason ? String(r.reason) : (r && r.disposition) };
    } catch (e) {
      return { ok: false, reason: "renew-error:" + (e && e.message ? e.message : e) };
    } finally {
      if (store && typeof store.end === "function") { try { await store.end(); } catch { /* ignore */ } }
    }
  };
  const ownershipBackfill = async () => {
    const mod = await import(ownershipModulePath);
    // Scoped mode: the ownership backfill processes EXACTLY the frozen accounts (never the full snapshot set).
    return mod.backfillFbaOwnership(scoped ? { dry: false, readers: { listAccounts: async () => [...scoped] } } : { dry: false });
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
    const primaryIds = await scopedDiscoverAccounts();
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
    runtime, publisher, controls, readbackLive, ownershipBackfill, verifyLease,
    loadAccounts, resolveOverflowSellers,
    connections: getConnections(),
    scopeReaders: { resolveDataDoeAccountIds: resolveAccountIds, getSourceCoverageWindows: readCoverage },
    getSourceExportCache: readExportCache,
    operator,
  });
}
