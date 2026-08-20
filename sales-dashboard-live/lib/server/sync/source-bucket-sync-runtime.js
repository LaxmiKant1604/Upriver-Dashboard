// Scheduler v2 -- PRODUCTION COMPOSITION for the bucket source sync ("Sync missing data"; ZERO-I/O build).
//
// Wires runBucketSourceSync to the production primitives: DataDoe discovery (primary accounts only), the
// Supabase source store + DataDoe adapter, the durable-model evidence readers (coverage / snapshots /
// controls) and sinks (history / coverage / snapshots / run status). Construction performs NO I/O -- every
// collaborator is assembled but never invoked until run() is called by an operator action. Every primitive
// is injectable, so the whole composition is offline-testable.
//
// The MANUAL operator action runs ONE bounded pass with cooldownMs 0 (a single serverless invocation cannot
// sleep between families; the >=1-minute completion-anchored cooldown is the SCHEDULER's cadence rule --
// see source-schedule.js). Coverage-driven planning means "Sync missing data" NEVER re-exports proven
// historical coverage, and a PAUSED source (source_controls) plans zero new exports.

import { getDataDoeConnections, classifyDirectoryAccounts, mergeDiscoveredDataDoeAccounts } from "../datadoe-connections.js";
import { fetchAccounts as fetchDataDoeAccounts } from "../datadoe.js";
import { organizationFingerprint } from "../source-identity.js";
import { addDaysStr } from "../date-windows.js";
import { bucketForCountry } from "./registry.js";
import { makeSupabaseSourceStore, makeDataDoeAdapter } from "./source-sync-driver.js";
import { runBucketSourceSync, SOURCE_SYNC_OWNER_REPORT_KEY } from "./source-bucket-sync.js";
import { OLI_SOURCE_KEY, CATALOG_SOURCE_KEY, FBA_INVENTORY_SOURCE_KEY, ORGANIZATION_SCOPE_KEY } from "./source-durable-model.js";
import { SOURCE_REGISTRY, sourceRegistryEntry } from "./source-registry.js";
import {
  getSourceControls, getSourceCoverageWindows, getSourceSnapshot,
  upsertSourceOliHistoryRows, recordSourceCoverageWindows, recordSourceSnapshot, upsertSourceRunStatus,
} from "../supabase.js";

export { SOURCE_SYNC_OWNER_REPORT_KEY };

/**
 * Build the production bucket-sync runtime. Overrides exist for tests only; production callers pass none.
 * Returns { run({ bucket, asOf?, today?, cycleDate?, reuseOnly? }) } -- run() performs the I/O.
 */
export function buildBucketSourceSyncRuntime(overrides = {}) {
  const {
    getConnections = getDataDoeConnections,
    fetchAccounts = fetchDataDoeAccounts,
    makeSourceStore = makeSupabaseSourceStore,
    makeAdapter = makeDataDoeAdapter,
    readSourceControls = getSourceControls,
    readCoverage = getSourceCoverageWindows,
    readSnapshot = getSourceSnapshot,
    persistHistory = upsertSourceOliHistoryRows,
    recordCoverage = recordSourceCoverageWindows,
    persistSnapshot = recordSourceSnapshot,
    updateRunStatus = upsertSourceRunStatus,
    clock = () => Date.now(),
  } = overrides;

  return {
    // `onlySourceKey` scopes a per-CARD "Sync missing data" action to ONE source family: every OTHER
    // registered family is treated as paused for this run (zero exports), while the durable pause state is
    // still honored -- a paused source can never be synced through this scoping (fail closed).
    run: async ({ bucket, asOf = null, today = null, cycleDate = null, reuseOnly = false, onlySourceKey = null } = {}) => {
      if (bucket !== "us" && bucket !== "non-us") {
        throw new Error(`buildBucketSourceSyncRuntime.run requires bucket 'us'|'non-us' (got "${bucket}").`);
      }
      if (onlySourceKey != null) sourceRegistryEntry(onlySourceKey); // typed UNREGISTERED_SOURCE (fail closed)
      const connections = getConnections() || [];
      const primary = connections.find((c) => c && c.id === "primary" && String(c.apiKey || "").trim());
      if (!primary) throw new Error("bucket source sync requires a configured primary DataDoe connection (fail closed).");
      const orgFingerprint = primary.organizationFingerprint || organizationFingerprint(primary.apiKey);

      // Discover the CURRENT primary accounts (a read-only accounts GET, never an export) and keep this
      // bucket's. rawSellerId: a primary public id IS the DataDoe seller/vendor id (dd-secondary accounts are
      // excluded -- they never route through the primary key).
      const byConnection = [];
      for (const connection of connections) {
        if (!connection || !connection.apiKey) continue;
        const accounts = await fetchAccounts(connection.apiKey);
        byConnection.push({ connection, accounts: accounts || [] });
      }
      const directoryRows = mergeDiscoveredDataDoeAccounts(byConnection);
      const { active } = classifyDirectoryAccounts(directoryRows, connections);
      const accounts = active
        .map((a) => ({ accountId: a.accountId ?? a.id, country: a.country }))
        .filter((a) => a.accountId && bucketForCountry(a.country) === bucket)
        .map((a) => ({ accountId: String(a.accountId), rawSellerId: String(a.accountId) }));
      if (!accounts.length) {
        return { bucket, skipped: "no-bucket-accounts", accounts: 0 };
      }

      // Durable evidence reads: controls (paused sources), per-account OLI coverage, catalog + FBA snapshots.
      const controls = await readSourceControls();
      const pausedSources = new Set((controls.rows || []).filter((r) => r.paused === true).map((r) => r.source_key));
      if (onlySourceKey != null) {
        if (pausedSources.has(onlySourceKey)) {
          const err = new Error(`SOURCE_PAUSED: "${onlySourceKey}" is paused; resume it before syncing missing data (fail closed).`);
          err.code = "SOURCE_PAUSED";
          err.status = 409;
          throw err;
        }
        for (const entry of SOURCE_REGISTRY) {
          if (entry.sourceKey !== onlySourceKey) pausedSources.add(entry.sourceKey);
        }
      }
      const coverageByAccountId = {};
      for (const a of accounts) {
        const cov = await readCoverage({ organizationFingerprint: orgFingerprint, accountId: a.accountId, sourceKey: OLI_SOURCE_KEY });
        coverageByAccountId[a.accountId] = cov.read === "ok" ? cov.windows : [];
      }
      const catalogSnap = await readSnapshot({ sourceKey: CATALOG_SOURCE_KEY, scopeKey: ORGANIZATION_SCOPE_KEY });
      const fbaSnapshotsByAccount = {};
      for (const a of accounts) {
        const snap = await readSnapshot({ sourceKey: FBA_INVENTORY_SOURCE_KEY, scopeKey: a.accountId });
        if (snap.snapshot) fbaSnapshotsByAccount[a.accountId] = snap.snapshot;
      }

      const todayStr = today || new Date(clock()).toISOString().slice(0, 10);
      const asOfStr = asOf || addDaysStr(todayStr, -1); // the latest COMPLETED day (conservative for manual runs)
      const store = makeSourceStore();
      const dataDoe = makeAdapter(connections);

      return runBucketSourceSync({
        apiKey: primary.apiKey, bucket, accounts,
        coverageByAccountId,
        catalogSnapshot: catalogSnap.snapshot,
        fbaSnapshotsByAccount,
        pausedSources,
        asOf: asOfStr, today: todayStr,
        store, dataDoe,
        persistHistory, recordCoverage, persistSnapshot, updateRunStatus,
        cycleDate: cycleDate || todayStr, trigger: "manual",
        clock, wait: null, cooldownMs: 0, // ONE bounded manual pass; the scheduler owns cadence/cooldown
        reuseOnly,
      });
    },
  };
}
