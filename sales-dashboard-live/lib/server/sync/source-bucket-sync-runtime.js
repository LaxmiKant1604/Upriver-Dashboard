// Scheduler v2 -- PRODUCTION COMPOSITION for the source workflow (ZERO-I/O build; senior-review hardened).
//
// Wires the bucket source sync + the source-card actions to the production primitives, with the reviewed
// production-path guarantees:
//   FINDING 1: EVERY durable evidence read (controls / coverage / snapshots / membership) must come back
//     read:"ok" BEFORE any DataDoe create, Supabase write, or cycle creation -- a schema-missing
//     (migration-unapplied) or failed read is a TYPED zero-export refusal, never a silent empty default.
//   FINDING 2: only correctly bound PRIMARY accounts enter the bucket sync -- a dd-secondary/public-prefixed
//     id (any id containing ":") or an account without a marketplace country is EXCLUDED (recorded, never
//     routed through the primary key).
//   FINDING 3: a REAL serverless deadline: run() computes deadlineMs = clock() + budgetMs (default 50s under
//     the 60s route) with reserve headroom; work per invocation is bounded and the rollup is typed-resumable
//     (continuationRequired) -- a fresh invocation re-enters the same cycle with no duplicate create.
//   FINDING 4: runSourceCardAction routes EVERY registered source to its REAL architecture or refuses typed:
//     durable-history/durable-snapshot families -> the bucket sync; cycle-cache families -> the REAL fixpoint
//     composition (buildSchedulerV2SourceTrancheRuntime, readiness+rollout gated); durable-ads families ->
//     a typed refusal naming the existing durable Ads architecture. After a complete bucket sync the runtime
//     loads the durable Ads evidence and derives/validates/saves the Daily Reporting + Brand View durable
//     SHADOW snapshots (scheduler-v2/* namespace; nothing live is touched).
//   FINDING 7: durable source_batch_membership is LOADED and new accounts are TRANSACTIONALLY assigned via
//     the assign_source_account_batch RPC -- batches are stable across invocations, never recomputed ad hoc.
//   FINDING 8: gatherDurableReadiness computes dashboard readiness from AUTHORITATIVE per-account durable
//     coverage / snapshot freshness / per-account Ads windows -- never from last_status alone.
//
// Construction performs NO I/O; every primitive is injectable so the whole composition is offline-testable.

import { getDataDoeConnections, classifyDirectoryAccounts, mergeDiscoveredDataDoeAccounts } from "../datadoe-connections.js";
import { fetchAccounts as fetchDataDoeAccounts } from "../datadoe.js";
import { organizationFingerprint } from "../source-identity.js";
import { addDaysStr, monthBackStr } from "../date-windows.js";
import { sourceContractForKey } from "../source-contracts.js";
import { bucketForCountry } from "./registry.js";
import { makeSupabaseSourceStore, makeDataDoeAdapter } from "./source-sync-driver.js";
import { makeShadowSnapshotSaver } from "./report-snapshot-store.js";
import { buildSchedulerV2SourceTrancheRuntime } from "./runtime-composition.js";
import { runSourceFixpoint } from "./source-fixpoint.js";
import { batchFamilyKey } from "./source-batching.js";
import { runBucketSourceSync, SOURCE_SYNC_OWNER_REPORT_KEY } from "./source-bucket-sync.js";
import { REPORT_SOURCE_CONTRACTS } from "./report-source-contracts.js";
import {
  OLI_SOURCE_KEY, CATALOG_SOURCE_KEY, FBA_INVENTORY_SOURCE_KEY, ORGANIZATION_SCOPE_KEY,
  oliBackfillWindow,
} from "./source-durable-model.js";
import { SOURCE_REGISTRY, sourceRegistryEntry } from "./source-registry.js";
import {
  deriveDurableDashboardSnapshots, DAILY_ADS_GRAIN, BRAND_VIEW_ADS_GRAIN,
  dailyReportingReadiness, brandViewReadiness,
} from "./durable-dashboards.js";
import {
  getSourceControls, getSourceCoverageWindows, getSourceSnapshot,
  recordSourceSnapshot, upsertSourceRunStatus,
  replaceOliHistoryWindow, saveSourceSnapshotPayload, getSourceSnapshotPayload,
  getSourceOliHistoryRows, getDailyAdsCoverage,
  listSourceBatchMembership, assignSourceAccountBatch,
} from "../supabase.js";

export { SOURCE_SYNC_OWNER_REPORT_KEY };

export const DEFAULT_ROUTE_BUDGET_MS = 50_000; // under config.maxDuration = 60 with reserve headroom
export const DEFAULT_ROUTE_RESERVE_MS = 5_000;

// FINDING 1: a durable evidence read that is not read:"ok" is a TYPED zero-export refusal.
function requireOkRead(result, label) {
  if (result && result.read === "ok") return result;
  const code = result && result.read === "schema-missing" ? "DURABLE_MODEL_UNAVAILABLE" : "SOURCE_EVIDENCE_READ_FAILED";
  const err = new Error(`${code}: ${label} read was "${result ? result.read : "missing"}"; refusing before any export/write/cycle (fail closed; zero-export).`);
  err.code = code;
  err.status = 503;
  throw err;
}

// FINDING 2: keep ONLY correctly bound primary accounts. A primary public id IS the DataDoe seller id and
// never contains ":" (dd-secondary + unknown-connection ids are prefixed). Country is required (FBA row
// validation + bucket mapping). Excluded accounts are RETURNED for telemetry, never silently dropped
// into the primary key.
export function bindPrimaryBucketAccounts(activeAccounts, bucket) {
  const accounts = [];
  const excluded = [];
  for (const a of activeAccounts || []) {
    const accountId = String((a && (a.accountId ?? a.id)) || "").trim();
    const country = String((a && a.country) || "").trim();
    if (!accountId) continue;
    if (accountId.includes(":")) { excluded.push({ accountId, reason: "non-primary-connection" }); continue; }
    if (!country) { excluded.push({ accountId, reason: "missing-marketplace-country" }); continue; }
    if (bucketForCountry(country) !== bucket) continue; // the other bucket's account, not an exclusion
    accounts.push({ accountId, rawSellerId: accountId, country });
  }
  return { accounts, excluded };
}

// The durable batch family for the canonical OLI fragment (stable compatibility key; date-free).
export function oliBatchFamily({ orgFingerprint, bucket }) {
  const c = (REPORT_SOURCE_CONTRACTS["daily-reporting"] || []).find((x) => x.requestKey === "daily-reporting:oli-sales");
  if (!c) throw new Error("oliBatchFamily: the canonical OLI contract is missing (fail closed).");
  return batchFamilyKey({
    organizationFingerprint: orgFingerprint, connectionId: "primary", bucket,
    sourceId: sourceContractForKey(OLI_SOURCE_KEY).ids[0],
    columns: c.columns, groupBy: c.groupBy, aggregations: c.aggregations,
    orderByColumn: c.orderByColumn, orderByDirection: c.orderByDirection,
    limit: c.limit, windowKind: "canonical-oli-slices", marketplaceConstraint: null,
  });
}

/**
 * Build the production source-workflow runtime. Overrides exist for tests only; production callers pass none.
 * Returns:
 *   run(args)                 -- the bucket source sync (bounded, resumable, evidence-gated);
 *   runSourceCardAction(args) -- routes ONE registered source card action to its real architecture;
 *   gatherDurableReadiness(a) -- authoritative Daily/Brand View readiness from durable evidence.
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
    readAdsCoverage = getDailyAdsCoverage,
    readBatchMembership = listSourceBatchMembership,
    assignBatchMembership = assignSourceAccountBatch,
    replaceHistory = replaceOliHistoryWindow,
    saveSnapshotPayload = saveSourceSnapshotPayload,
    loadSnapshotPayload = getSourceSnapshotPayload,
    recordSnapshot = recordSourceSnapshot,
    loadHistoryRows = getSourceOliHistoryRows,
    updateRunStatus = upsertSourceRunStatus,
    makeShadowSaver = makeShadowSnapshotSaver,
    composeFixpoint = null, // test seam; default composes the REAL fixpoint below
    clock = () => Date.now(),
    budgetMs = DEFAULT_ROUTE_BUDGET_MS,
    reserveMs = DEFAULT_ROUTE_RESERVE_MS,
  } = overrides;

  // FINDING 6: the collaborator the bucket sync calls with ROWS -- production copies them into the durable
  // source-snapshots/* namespace (never pruned with the 24h cache) and records THAT pointer atomically-enough
  // (pointer written only after the object upload succeeded; a failed upload records nothing).
  const persistSnapshot = async ({ sourceKey, scopeKey, rows, rowCount, sourceRequestHash, validatedAt }) => {
    const saved = await saveSnapshotPayload({ sourceKey, scopeKey, rows });
    await recordSnapshot({
      sourceKey, scopeKey, objectPath: saved.objectPath, rowCount,
      payloadBytes: saved.payloadBytes, sourceRequestHash, validatedAt,
    });
    return { write: "ok", objectPath: saved.objectPath };
  };

  const resolvePrimary = () => {
    const connections = getConnections() || [];
    const primary = connections.find((c) => c && c.id === "primary" && String(c.apiKey || "").trim());
    if (!primary) throw new Error("bucket source sync requires a configured primary DataDoe connection (fail closed).");
    return { connections, primary, orgFingerprint: primary.organizationFingerprint || organizationFingerprint(primary.apiKey) };
  };

  const discoverBucketAccounts = async ({ connections, bucket }) => {
    const byConnection = [];
    for (const connection of connections) {
      if (!connection || !connection.apiKey) continue;
      const accounts = await fetchAccounts(connection.apiKey);
      byConnection.push({ connection, accounts: accounts || [] });
    }
    const directoryRows = mergeDiscoveredDataDoeAccounts(byConnection);
    const { active } = classifyDirectoryAccounts(directoryRows, connections);
    return bindPrimaryBucketAccounts(active, bucket);
  };

  // FINDING 8: authoritative per-account evidence gathering. Read failures become TYPED blocked entries
  // (never a fabricated "ready", never a 500): the dashboard is blocked with the read reason.
  const gatherEvidence = async ({ orgFingerprint, accounts }) => {
    const readBlockers = [];
    const oliCoverageByAccountId = {};
    for (const a of accounts) {
      const cov = await readCoverage({ organizationFingerprint: orgFingerprint, accountId: a.accountId, sourceKey: OLI_SOURCE_KEY });
      if (cov.read !== "ok") {
        readBlockers.push({ sourceKey: OLI_SOURCE_KEY, accountId: a.accountId, reason: "coverage-" + cov.read, blocksSales: true });
        oliCoverageByAccountId[a.accountId] = [];
      } else {
        oliCoverageByAccountId[a.accountId] = cov.windows;
      }
    }
    const catalogRead = await readSnapshot({ sourceKey: CATALOG_SOURCE_KEY, scopeKey: ORGANIZATION_SCOPE_KEY });
    if (catalogRead.read !== "ok") readBlockers.push({ sourceKey: CATALOG_SOURCE_KEY, reason: "snapshot-" + catalogRead.read, blocksSales: true });
    const fbaSnapshotsByAccount = {};
    for (const a of accounts) {
      const snap = await readSnapshot({ sourceKey: FBA_INVENTORY_SOURCE_KEY, scopeKey: a.accountId });
      if (snap.read !== "ok") readBlockers.push({ sourceKey: FBA_INVENTORY_SOURCE_KEY, accountId: a.accountId, reason: "snapshot-" + snap.read, blocksSales: false });
      else if (snap.snapshot) fbaSnapshotsByAccount[a.accountId] = snap.snapshot;
    }
    const campaignWindows = {};
    const asinWindows = {};
    for (const a of accounts) {
      const camp = await readAdsCoverage(a.accountId, "campaign-performance-v1");
      campaignWindows[a.accountId] = camp.read === "ok" ? camp.windows : null;
      if (camp.read !== "ok") readBlockers.push({ sourceKey: "ads-campaign-date", accountId: a.accountId, reason: "ads-coverage-" + camp.read, blocksSales: false });
      const asin = await readAdsCoverage(a.accountId, "asin-performance-v1");
      asinWindows[a.accountId] = asin.read === "ok" ? asin.windows : null;
      if (asin.read !== "ok") readBlockers.push({ sourceKey: "ads-asin-date", accountId: a.accountId, reason: "ads-coverage-" + asin.read, blocksSales: false });
    }
    return {
      readBlockers, oliCoverageByAccountId,
      catalogSnapshot: catalogRead.read === "ok" ? catalogRead.snapshot : null,
      fbaSnapshotsByAccount,
      campaignAds: { grain: DAILY_ADS_GRAIN, read: "ok", windowsByAccountId: Object.fromEntries(Object.entries(campaignWindows).map(([k, v]) => [k, v || []])) },
      asinAds: { grain: BRAND_VIEW_ADS_GRAIN, read: "ok", windowsByAccountId: Object.fromEntries(Object.entries(asinWindows).map(([k, v]) => [k, v || []])) },
    };
  };

  const run = async ({ bucket, asOf = null, today = null, cycleDate = null, reuseOnly = false, onlySourceKey = null } = {}) => {
    if (bucket !== "us" && bucket !== "non-us") {
      throw new Error(`buildBucketSourceSyncRuntime.run requires bucket 'us'|'non-us' (got "${bucket}").`);
    }
    if (onlySourceKey != null) sourceRegistryEntry(onlySourceKey); // typed UNREGISTERED_SOURCE (fail closed)
    const startMs = clock();
    const deadlineMs = startMs + Number(budgetMs); // FINDING 3: never Infinity under the bounded route

    // FINDING 1: controls FIRST -- an unapplied migration or failed read refuses BEFORE discovery.
    const controls = requireOkRead(await readSourceControls(), "source_controls");
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

    const { connections, primary, orgFingerprint } = resolvePrimary();
    const { accounts, excluded } = await discoverBucketAccounts({ connections, bucket });
    if (!accounts.length) {
      return { bucket, skipped: "no-bucket-accounts", accounts: 0, excludedAccounts: excluded };
    }

    // FINDING 1: evidence reads fail closed BEFORE any cycle/store/DataDoe work.
    const coverageByAccountId = {};
    for (const a of accounts) {
      const cov = requireOkRead(
        await readCoverage({ organizationFingerprint: orgFingerprint, accountId: a.accountId, sourceKey: OLI_SOURCE_KEY }),
        `source_coverage(${a.accountId})`,
      );
      coverageByAccountId[a.accountId] = cov.windows;
    }
    const catalogSnap = requireOkRead(await readSnapshot({ sourceKey: CATALOG_SOURCE_KEY, scopeKey: ORGANIZATION_SCOPE_KEY }), "source_snapshots(catalog)");
    const fbaSnapshotsByAccount = {};
    for (const a of accounts) {
      const snap = requireOkRead(await readSnapshot({ sourceKey: FBA_INVENTORY_SOURCE_KEY, scopeKey: a.accountId }), `source_snapshots(fba:${a.accountId})`);
      if (snap.snapshot) fbaSnapshotsByAccount[a.accountId] = snap.snapshot;
    }

    // FINDING 7: durable, transactionally-assigned stable batch membership (never recomputed ad hoc).
    const batchFamily = oliBatchFamily({ orgFingerprint, bucket });
    let membershipRows;
    try {
      membershipRows = await readBatchMembership(batchFamily);
    } catch (_e) {
      const err = new Error("BATCH_MEMBERSHIP_READ_FAILED: durable source_batch_membership could not be read; refusing before any export (fail closed).");
      err.code = "BATCH_MEMBERSHIP_READ_FAILED";
      err.status = 503;
      throw err;
    }
    const existingMembership = new Map((membershipRows || []).map((r) => [String(r.account_id ?? r.accountId), Number(r.batch_index ?? r.batchIndex)]));
    for (const a of accounts) {
      if (existingMembership.has(a.accountId)) continue;
      const idx = await assignBatchMembership({ batchFamily, accountId: a.accountId, connectionId: "primary", organizationFingerprint: orgFingerprint });
      if (!Number.isInteger(idx) || idx < 0) {
        const err = new Error("BATCH_MEMBERSHIP_ASSIGN_FAILED: transactional batch assignment returned a malformed index; refusing (fail closed).");
        err.code = "BATCH_MEMBERSHIP_ASSIGN_FAILED";
        throw err;
      }
      existingMembership.set(a.accountId, idx);
    }

    const todayStr = today || new Date(clock()).toISOString().slice(0, 10);
    const asOfStr = asOf || addDaysStr(todayStr, -1); // the latest COMPLETED day (conservative for manual runs)
    const store = makeSourceStore();
    const dataDoe = makeAdapter(connections);

    const rollup = await runBucketSourceSync({
      apiKey: primary.apiKey, bucket, accounts,
      existingMembership,
      coverageByAccountId,
      catalogSnapshot: catalogSnap.snapshot,
      fbaSnapshotsByAccount,
      pausedSources,
      asOf: asOfStr, today: todayStr,
      store, dataDoe,
      replaceHistoryWindow: replaceHistory, persistSnapshot, updateRunStatus,
      cycleDate: cycleDate || todayStr, trigger: "manual",
      clock, wait: null, cooldownMs: 0, // ONE bounded manual pass; the scheduler owns cadence/cooldown
      deadlineMs, reserveMs,
      reuseOnly,
    });
    rollup.excludedAccounts = excluded;

    // FINDING 4: after a COMPLETE bucket sync (not stopped/resumable), load the durable Ads evidence and
    // derive/validate/save the Daily + Brand View durable SHADOW snapshots. A read failure or non-ready
    // readiness is a TYPED skip -- nothing is fabricated, nothing live is touched.
    rollup.derived = { skipped: null, daily: null, brandView: null };
    if (rollup.stopped || rollup.continuationRequired || !rollup.globalDrained) {
      rollup.derived.skipped = rollup.stopped ? "bucket-stopped" : (rollup.continuationRequired ? "continuation-required" : "not-drained");
      return rollup;
    }
    const evidence = await gatherEvidence({ orgFingerprint, accounts });
    const catalogForMaps = evidence.catalogSnapshot;
    if (!catalogForMaps || !catalogForMaps.object_path) {
      rollup.derived.skipped = "catalog-snapshot-missing";
      return rollup;
    }
    let catalogRows = null;
    try {
      const payload = await loadSnapshotPayload(catalogForMaps.object_path);
      if (payload && Array.isArray(payload.rows)) catalogRows = payload.rows;
    } catch (_e) { catalogRows = null; }
    if (!catalogRows) {
      rollup.derived.skipped = "catalog-hydration-failed";
      return rollup;
    }
    const dailyWindow = { from: monthBackStr(asOfStr, 5), to: asOfStr };
    const brandViewWindow = oliBackfillWindow(asOfStr);
    let historyRows = null;
    try {
      historyRows = await loadHistoryRows({
        organizationFingerprint: orgFingerprint, connectionId: "primary",
        accountIds: accounts.map((a) => a.accountId),
        from: brandViewWindow.from, to: brandViewWindow.to,
      });
    } catch (_e) { historyRows = null; }
    if (!Array.isArray(historyRows)) {
      rollup.derived.skipped = "history-read-failed";
      return rollup;
    }
    const derived = deriveDurableDashboardSnapshots({
      bucket, accounts: accounts.map((a) => a.accountId), historyRows, catalogRows,
      oliCoverageByAccountId: evidence.oliCoverageByAccountId,
      catalogSnapshot: evidence.catalogSnapshot,
      fbaSnapshotsByAccount: evidence.fbaSnapshotsByAccount,
      campaignAds: evidence.campaignAds, asinAds: evidence.asinAds,
      dailyWindow, brandViewWindow,
    });
    const saver = makeShadowSaver();
    const nowIso = () => new Date(clock()).toISOString();
    let dailySaved = 0;
    if (derived.daily.snapshots) {
      for (const snap of derived.daily.snapshots) {
        await saver({
          reportKey: snap.reportKey, accountId: snap.accountId,
          params: { reportVersion: snap.version, bucket, from: dailyWindow.from, to: dailyWindow.to },
          payload: snap.payload, sourceRefreshedAt: nowIso(),
        });
        dailySaved += 1;
      }
    }
    let brandViewSaved = 0;
    if (derived.brandView.snapshot) {
      const snap = derived.brandView.snapshot;
      await saver({
        reportKey: snap.reportKey, accountId: snap.accountId,
        params: { reportVersion: snap.version, bucket, from: brandViewWindow.from, to: brandViewWindow.to },
        payload: snap.payload, sourceRefreshedAt: nowIso(),
      });
      brandViewSaved = 1;
    }
    rollup.derived = {
      skipped: null,
      daily: { ready: derived.daily.readiness.ready, adsReady: derived.daily.readiness.adsReady, saved: dailySaved },
      brandView: { ready: derived.brandView.readiness.ready, adsReady: derived.brandView.readiness.adsReady, saved: brandViewSaved },
    };
    return rollup;
  };

  // FINDING 4: the default REAL fixpoint composition for cycle-cache families -- the trusted per-tranche
  // runtime (readiness-gated, rollout-gated, one bounded manual pass, real serverless deadline).
  const defaultComposeFixpoint = async ({ bucket, reportKeys, cycleDate, deadlineMs, asOf }) => runSourceFixpoint({
    composeRuntime: (spec) => buildSchedulerV2SourceTrancheRuntime(spec, {}),
    store: makeSourceStore(),
    bucket, cycleDate, reportKeys, manualReportKeys: reportKeys,
    asOf, asOfFor: () => asOf,
    clock, wait: null, cooldownMs: 0,
    maxContinuationsPerFamily: 2, maxWalks: 1,
    deadlineMs, reserveMs, trigger: "manual",
  });

  const runSourceCardAction = async ({ bucket, sourceKey, reuseOnly = false } = {}) => {
    const entry = sourceRegistryEntry(sourceKey); // typed UNREGISTERED_SOURCE (fail closed)
    if (bucket !== "us" && bucket !== "non-us") {
      throw new Error(`runSourceCardAction requires bucket 'us'|'non-us' (got "${bucket}").`);
    }
    if (entry.storage === "durable-ads") {
      // The REAL architecture for the four Ads families is the existing durable Ads sync (its own bounded
      // cron scopes + coverage model). Executing it from a source card is a separate reviewed wiring, so
      // this action refuses TYPED rather than pretending.
      return {
        refused: true, code: "SOURCE_ACTION_ADS_ARCHITECTURE",
        message: "This family is fetched by the existing durable Ads architecture (bounded cron scopes); use that path.",
        sourceKey, bucket,
      };
    }
    if (entry.storage === "durable-history" || entry.storage === "durable-snapshot") {
      return run({ bucket, onlySourceKey: sourceKey, reuseOnly });
    }
    // cycle-cache families: compose the REAL fixpoint scoped to the family's consumer reports.
    const startMs = clock();
    const todayStr = new Date(startMs).toISOString().slice(0, 10);
    const compose = composeFixpoint || defaultComposeFixpoint;
    const result = await compose({
      bucket, sourceKey,
      reportKeys: [...entry.usedByReports],
      cycleDate: todayStr, asOf: addDaysStr(todayStr, -1),
      deadlineMs: startMs + Number(budgetMs), reserveMs,
    });
    return { refused: false, architecture: "fixpoint", sourceKey, bucket, result };
  };

  const gatherDurableReadiness = async ({ bucket, accounts, asOf = null } = {}) => {
    if (bucket !== "us" && bucket !== "non-us") throw new Error("gatherDurableReadiness requires bucket 'us'|'non-us' (fail closed).");
    const bound = (accounts || []).filter((a) => a && a.accountId && !String(a.accountId).includes(":"));
    const ids = bound.map((a) => String(a.accountId));
    const { orgFingerprint } = resolvePrimary();
    const todayStr = new Date(clock()).toISOString().slice(0, 10);
    const asOfStr = asOf || addDaysStr(todayStr, -1);
    const evidence = await gatherEvidence({ orgFingerprint, accounts: ids.map((accountId) => ({ accountId })) });
    const dailyWindow = { from: monthBackStr(asOfStr, 5), to: asOfStr };
    const brandViewWindow = oliBackfillWindow(asOfStr);
    const daily = dailyReportingReadiness({
      accounts: ids, oliCoverageByAccountId: evidence.oliCoverageByAccountId,
      catalogSnapshot: evidence.catalogSnapshot, campaignAds: evidence.campaignAds,
      from: dailyWindow.from, to: dailyWindow.to,
    });
    const brandView = brandViewReadiness({
      accounts: ids, oliCoverageByAccountId: evidence.oliCoverageByAccountId,
      catalogSnapshot: evidence.catalogSnapshot, asinAds: evidence.asinAds,
      fbaSnapshotsByAccount: evidence.fbaSnapshotsByAccount,
      from: brandViewWindow.from, to: brandViewWindow.to,
    });
    // Merge the typed read-failure blockers so a failed read can never present as healthy evidence.
    const merge = (r, keys) => {
      const readBlocked = evidence.readBlockers.filter((b) => keys.includes(b.sourceKey));
      const blockedBy = [...readBlocked, ...r.blockedBy];
      return { ...r, blockedBy, ready: r.ready && !readBlocked.some((b) => b.blocksSales) };
    };
    return {
      asOf: asOfStr,
      daily: merge(daily, ["order-line-items", "product-catalog", "ads-campaign-date"]),
      brandView: merge(brandView, ["order-line-items", "product-catalog", "ads-asin-date", "fba-inventory-health"]),
    };
  };

  return { run, runSourceCardAction, gatherDurableReadiness };
}
