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
import { batchFamilyKey } from "./source-batching.js";
import { runBucketSourceSync, SOURCE_SYNC_OWNER_REPORT_KEY } from "./source-bucket-sync.js";
import { REPORT_SOURCE_CONTRACTS } from "./report-source-contracts.js";
import {
  OLI_SOURCE_KEY, CATALOG_SOURCE_KEY, FBA_INVENTORY_SOURCE_KEY, ORGANIZATION_SCOPE_KEY,
  oliBackfillWindow, snapshotRefreshDecision,
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
  getSourceOliHistoryRows, getDailyAdsCoverage, getAdDailyMetrics,
  listSourceBatchMembership, assignSourceAccountBatch,
  getReportSyncSettings, getSchedulerAccountRollout,
  upsertSyncReportJob, claimReportDeriveAttempt, recordSyncReportSuccess,
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
    accounts.push({ accountId, rawSellerId: accountId, country, name: String((a && a.name) || accountId), currency: String((a && a.currency) || "") || null });
  }
  return { accounts, excluded };
}

// Finding 6: validate EVERY loaded durable membership row before accepting it -- canonical nonblank
// primary account (never a prefixed id), the exact primary connection, THIS organization's fingerprint, an
// integer batch index >= 0, no duplicate account, and the <=5-per-batch invariant. ANY violation is a typed
// fail-closed refusal (corrupt durable state must never seed a plan).
export function validateBatchMembershipRows(rows, { orgFingerprint }) {
  const membership = new Map();
  const perIndex = new Map();
  for (const r of rows || []) {
    const rawId = String(r.account_id ?? r.accountId ?? "");
    // Round-4 finding 9: a NONCANONICAL id (leading/trailing whitespace) is REJECTED, never trimmed --
    // trimming would silently re-home a row onto a different canonical identity.
    if (rawId !== rawId.trim()) {
      const err = new Error("BATCH_MEMBERSHIP_CORRUPT: durable source_batch_membership row is invalid (noncanonical whitespace account_id); refusing before any export (fail closed).");
      err.code = "BATCH_MEMBERSHIP_CORRUPT";
      err.status = 503;
      throw err;
    }
    const accountId = rawId;
    const connectionId = r.connection_id ?? r.connectionId;
    const org = r.organization_fingerprint ?? r.organizationFingerprint;
    const idx = r.batch_index ?? r.batchIndex;
    const bad = (reason) => {
      const err = new Error(`BATCH_MEMBERSHIP_CORRUPT: durable source_batch_membership row is invalid (${reason}); refusing before any export (fail closed).`);
      err.code = "BATCH_MEMBERSHIP_CORRUPT";
      err.status = 503;
      throw err;
    };
    if (!accountId) bad("blank account_id");
    if (accountId.includes(":")) bad("non-primary prefixed account_id");
    if (connectionId !== "primary") bad("connection_id is not primary");
    if (org !== orgFingerprint) bad("organization_fingerprint does not match this organization");
    if (!Number.isInteger(idx) || idx < 0) bad("batch_index is not a non-negative integer");
    if (membership.has(accountId)) bad("duplicate account membership");
    membership.set(accountId, idx);
    perIndex.set(idx, (perIndex.get(idx) || 0) + 1);
    if (perIndex.get(idx) > 5) bad("a batch exceeds the five-account maximum");
  }
  return membership;
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
    readAdMetrics = getAdDailyMetrics,
    readBatchMembership = listSourceBatchMembership,
    assignBatchMembership = assignSourceAccountBatch,
    readSettings = getReportSyncSettings,
    readRollout = getSchedulerAccountRollout,
    // Round-4 finding 3: the GENUINE publication lineage -- every durable shadow save records a real
    // sync_report_jobs row (validated derive/save success + the exact snapshot_params_hash), so the
    // approved publisher path can accept the snapshot with zero new mechanisms.
    reportLineage = { upsertReportJob: upsertSyncReportJob, claimReportDerive: claimReportDeriveAttempt, recordReportSuccess: recordSyncReportSuccess },
    composeTrancheRuntime = buildSchedulerV2SourceTrancheRuntime,
    replaceHistory = replaceOliHistoryWindow,
    saveSnapshotPayload = saveSourceSnapshotPayload,
    loadSnapshotPayload = getSourceSnapshotPayload,
    recordSnapshot = recordSourceSnapshot,
    loadHistoryRows = getSourceOliHistoryRows,
    updateRunStatus = upsertSourceRunStatus,
    makeShadowSaver = makeShadowSnapshotSaver,
    clock = () => Date.now(),
    budgetMs = DEFAULT_ROUTE_BUDGET_MS,
    reserveMs = DEFAULT_ROUTE_RESERVE_MS,
  } = overrides;

  // FINDINGS 5 + 6: the collaborator the bucket sync calls with ROWS -- production copies them into the
  // ORGANIZATION/CONNECTION-scoped, CONTENT-ADDRESSED source-snapshots/* namespace (immutable objects the
  // cache prune can never touch), then records the pointer WITH the content hash: whatever save wins the
  // pointer, its metadata provably references a complete object of its own content.
  const makePersistSnapshot = (orgFingerprint) => async ({ sourceKey, scopeKey, rows, rowCount, sourceRequestHash, validatedAt }) => {
    const saved = await saveSnapshotPayload({ organizationFingerprint: orgFingerprint, connectionId: "primary", sourceKey, scopeKey, rows });
    await recordSnapshot({
      organizationFingerprint: orgFingerprint, connectionId: "primary",
      sourceKey, scopeKey, objectPath: saved.objectPath, payloadSha: saved.payloadSha, rowCount,
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

  // FINDINGS 7 + 8: authoritative per-account evidence gathering. Read failures become TYPED blocked
  // entries (never a fabricated "ready", never a 500). Snapshot evidence is validated for freshness policy
  // (stale => typed degrade), exact ISOLATED identity (the read itself is org/connection-keyed), storage
  // HYDRATION (a dangling pointer blocks), row-count INTEGRITY, and content-hash provenance (the hydrator
  // proves payload<->metadata). Hydrated catalog rows are returned for the derive stage.
  const gatherEvidence = async ({ orgFingerprint, accounts, today = null, ensureTime = null }) => {
    const tick = async (label) => { if (ensureTime) await ensureTime(label); };
    const readBlockers = [];
    const oliCoverageByAccountId = {};
    for (const a of accounts) {
      await tick("coverage-read");
      const cov = await readCoverage({ organizationFingerprint: orgFingerprint, accountId: a.accountId, sourceKey: OLI_SOURCE_KEY });
      if (cov.read !== "ok") {
        readBlockers.push({ sourceKey: OLI_SOURCE_KEY, accountId: a.accountId, reason: "coverage-" + cov.read, blocksSales: true });
        oliCoverageByAccountId[a.accountId] = [];
      } else {
        oliCoverageByAccountId[a.accountId] = cov.windows;
      }
    }
    // A hydrating snapshot validator: freshness (policy), hydration (dangling), integrity (row count),
    // provenance (content hash -- enforced inside loadSnapshotPayload). Returns rows or null with blockers.
    const validateSnapshot = async ({ snapRead, sourceKey, accountId = undefined, blocksSales }) => {
      if (snapRead.read !== "ok") { readBlockers.push({ sourceKey, accountId, reason: "snapshot-" + snapRead.read, blocksSales }); return { snapshot: null, rows: null }; }
      const snapshot = snapRead.snapshot;
      if (!snapshot) return { snapshot: null, rows: null }; // honestly absent (readiness reports no-validated-snapshot)
      if (today) {
        try {
          const decision = snapshotRefreshDecision({ sourceKey, lastValidatedAt: snapshot.validated_at, today });
          if (decision.refresh) {
            // Round-4 finding 7: REQUIRED stale evidence BLOCKS readiness (ready:false) and its rows are
            // NEVER used for derivation -- the evidence is dropped, not merely annotated.
            readBlockers.push({ sourceKey, accountId, reason: "snapshot-stale", blocksSales: true });
            return { snapshot: null, rows: null };
          }
        } catch (_e) { /* non-daily-snapshot source: no freshness policy */ }
      }
      await tick("snapshot-hydration");
      let rows = null;
      try {
        const payload = await loadSnapshotPayload(snapshot.object_path);
        rows = payload.rows;
      } catch (_e) {
        readBlockers.push({ sourceKey, accountId, reason: "snapshot-dangling", blocksSales });
        return { snapshot: null, rows: null };
      }
      if (rows.length !== Number(snapshot.row_count)) {
        readBlockers.push({ sourceKey, accountId, reason: "snapshot-integrity", blocksSales });
        return { snapshot: null, rows: null };
      }
      return { snapshot, rows };
    };
    const catalogRead = await readSnapshot({ organizationFingerprint: orgFingerprint, connectionId: "primary", sourceKey: CATALOG_SOURCE_KEY, scopeKey: ORGANIZATION_SCOPE_KEY });
    const catalog = await validateSnapshot({ snapRead: catalogRead, sourceKey: CATALOG_SOURCE_KEY, blocksSales: true });
    const fbaSnapshotsByAccount = {};
    for (const a of accounts) {
      await tick("fba-snapshot-read");
      const snapRead = await readSnapshot({ organizationFingerprint: orgFingerprint, connectionId: "primary", sourceKey: FBA_INVENTORY_SOURCE_KEY, scopeKey: a.accountId });
      const fba = await validateSnapshot({ snapRead, sourceKey: FBA_INVENTORY_SOURCE_KEY, accountId: a.accountId, blocksSales: false });
      if (fba.snapshot) fbaSnapshotsByAccount[a.accountId] = fba.snapshot;
    }
    const campaignWindows = {};
    const asinWindows = {};
    const campaignCoverageStateByAccountId = {};
    for (const a of accounts) {
      await tick("ads-coverage-read");
      const camp = await readAdsCoverage(a.accountId, "campaign-performance-v1");
      campaignCoverageStateByAccountId[a.accountId] = camp;
      campaignWindows[a.accountId] = camp.read === "ok" ? camp.windows : null;
      if (camp.read !== "ok") readBlockers.push({ sourceKey: "ads-campaign-date", accountId: a.accountId, reason: "ads-coverage-" + camp.read, blocksSales: false });
      const asin = await readAdsCoverage(a.accountId, "asin-performance-v1");
      asinWindows[a.accountId] = asin.read === "ok" ? asin.windows : null;
      if (asin.read !== "ok") readBlockers.push({ sourceKey: "ads-asin-date", accountId: a.accountId, reason: "ads-coverage-" + asin.read, blocksSales: false });
    }
    return {
      readBlockers, oliCoverageByAccountId,
      catalogSnapshot: catalog.snapshot,
      catalogRows: catalog.rows,
      fbaSnapshotsByAccount,
      campaignCoverageStateByAccountId,
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
    // FINDING 2: ONE deadline across evidence reads, discovery, membership, the sync itself, hydration,
    // history loading, derivation, and saves. Expiry BEFORE/DURING a phase returns typed RESUMABLE state.
    const DEADLINE = Symbol("deadline");
    const outOfTime = () => clock() >= deadlineMs - reserveMs;
    const ensureTime = async (phase) => {
      if (outOfTime()) {
        const e = new Error(`deadline reached during ${phase}`);
        e[DEADLINE] = phase;
        throw e;
      }
    };
    const resumable = (phase) => ({ bucket, deadlineReached: true, continuationRequired: true, stopped: false, phase, skipped: "deadline" });
    const catchDeadline = (e) => { if (e && e[DEADLINE]) return resumable(e[DEADLINE]); throw e; };

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
    try { await ensureTime("discovery"); } catch (e) { return catchDeadline(e); }
    const { accounts, excluded } = await discoverBucketAccounts({ connections, bucket });
    if (!accounts.length) {
      return { bucket, skipped: "no-bucket-accounts", accounts: 0, excludedAccounts: excluded };
    }

    // FINDING 1: evidence reads fail closed BEFORE any cycle/store/DataDoe work. FINDING 2: each read is
    // deadline-checked; expiry returns typed resumable state.
    const coverageByAccountId = {};
    try {
      for (const a of accounts) {
        await ensureTime("evidence-coverage");
        const cov = requireOkRead(
          await readCoverage({ organizationFingerprint: orgFingerprint, accountId: a.accountId, sourceKey: OLI_SOURCE_KEY }),
          `source_coverage(${a.accountId})`,
        );
        coverageByAccountId[a.accountId] = cov.windows;
      }
    } catch (e) { return catchDeadline(e); }
    let catalogSnap;
    const fbaSnapshotsByAccount = {};
    try {
      await ensureTime("evidence-snapshots");
      catalogSnap = requireOkRead(await readSnapshot({ organizationFingerprint: orgFingerprint, connectionId: "primary", sourceKey: CATALOG_SOURCE_KEY, scopeKey: ORGANIZATION_SCOPE_KEY }), "source_snapshots(catalog)");
      for (const a of accounts) {
        await ensureTime("evidence-snapshots");
        const snap = requireOkRead(await readSnapshot({ organizationFingerprint: orgFingerprint, connectionId: "primary", sourceKey: FBA_INVENTORY_SOURCE_KEY, scopeKey: a.accountId }), `source_snapshots(fba:${a.accountId})`);
        if (snap.snapshot) fbaSnapshotsByAccount[a.accountId] = snap.snapshot;
      }
    } catch (e) { return catchDeadline(e); }

    // FINDING 7: durable, transactionally-assigned stable batch membership (never recomputed ad hoc);
    // FINDING 6: every loaded row is validated (canonical account / connection / organization / index /
    // uniqueness / <=5) before it may seed a plan.
    const batchFamily = oliBatchFamily({ orgFingerprint, bucket });
    let membershipRows;
    try {
      await ensureTime("membership-read");
      membershipRows = await readBatchMembership(batchFamily);
    } catch (e) {
      if (e && e[DEADLINE]) return resumable(e[DEADLINE]);
      const err = new Error("BATCH_MEMBERSHIP_READ_FAILED: durable source_batch_membership could not be read; refusing before any export (fail closed).");
      err.code = "BATCH_MEMBERSHIP_READ_FAILED";
      err.status = 503;
      throw err;
    }
    const existingMembership = validateBatchMembershipRows(membershipRows, { orgFingerprint });
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
      replaceHistoryWindow: replaceHistory, persistSnapshot: makePersistSnapshot(orgFingerprint), updateRunStatus,
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
    // FINDING 2: the derive half shares the SAME deadline (evidence, hydration, history, derivation, saves);
    // expiry is a typed resumable skip -- a fresh invocation finds the sources complete and derives directly.
    const deriveResumable = () => {
      rollup.derived.skipped = "deadline";
      rollup.deadlineReached = true;
      rollup.continuationRequired = true;
      return rollup;
    };
    let evidence;
    try {
      evidence = await gatherEvidence({ orgFingerprint, accounts, today: todayStr, ensureTime });
    } catch (e) { if (e && e[DEADLINE]) return deriveResumable(); throw e; }
    if (!evidence.catalogRows) {
      rollup.derived.skipped = evidence.catalogSnapshot ? "catalog-hydration-failed" : "catalog-snapshot-missing";
      return rollup;
    }
    const dailyWindow = { from: monthBackStr(asOfStr, 5), to: asOfStr };
    const brandViewWindow = oliBackfillWindow(asOfStr);
    let historyRows = null;
    const adMetricsByAccountId = {};
    try {
      await ensureTime("history-load");
      historyRows = await loadHistoryRows({
        organizationFingerprint: orgFingerprint, connectionId: "primary",
        accountIds: accounts.map((a) => a.accountId),
        from: brandViewWindow.from, to: brandViewWindow.to,
      });
      // FINDING 3 + round-4 finding 1: ACTUAL campaign Ads metric rows WITH their typed read state. A
      // failed/limited/malformed read is NEVER flattened into [] + "ok" -- the typed metricsRead travels
      // into the ads-coverage contract so Daily can never report a false zero-Ads result.
      for (const a of accounts) {
        await ensureTime("ads-metrics-load");
        try {
          const rows = await readAdMetrics(a.accountId, dailyWindow.from, dailyWindow.to);
          adMetricsByAccountId[a.accountId] = Array.isArray(rows)
            ? { rows, metricsRead: "ok" }
            : { rows: [], metricsRead: "read-failed" };
        } catch (e) {
          adMetricsByAccountId[a.accountId] = { rows: [], metricsRead: e && e.code === "ADS_ROW_LIMIT_EXCEEDED" ? "limit-exceeded" : "read-failed" };
        }
      }
    } catch (e) { if (e && e[DEADLINE]) return deriveResumable(); historyRows = null; }
    if (!Array.isArray(historyRows)) {
      rollup.derived.skipped = "history-read-failed";
      return rollup;
    }
    let derived;
    try {
      await ensureTime("derivation");
      derived = deriveDurableDashboardSnapshots({
        bucket, accounts, historyRows, catalogRows: evidence.catalogRows,
        oliCoverageByAccountId: evidence.oliCoverageByAccountId,
        catalogSnapshot: evidence.catalogSnapshot,
        fbaSnapshotsByAccount: evidence.fbaSnapshotsByAccount,
        campaignAds: evidence.campaignAds, asinAds: evidence.asinAds,
        adMetricsByAccountId,
        campaignCoverageStateByAccountId: evidence.campaignCoverageStateByAccountId,
        dailyWindow, brandViewWindow,
      });
    } catch (e) { if (e && e[DEADLINE]) return deriveResumable(); throw e; }
    const saver = makeShadowSaver();
    const nowIso = () => new Date(clock()).toISOString();
    let dailySaved = 0;
    let brandViewSaved = 0;
    // Round-4 finding 3: after each shadow save, record the GENUINE sync_report_jobs lineage -- a real job
    // row claimed and completed with validated derive/save success and the EXACT snapshot_params_hash the
    // saver computed, under the PRODUCTION report key. The approved publisher validates this exact row
    // (job hash === row hash === recomputed hash) with no new mechanism.
    const recordLineage = async (snap, saved, windowUsed, extraParams) => {
      if (!reportLineage || !rollup.cycleId) return;
      await reportLineage.upsertReportJob({
        cycleId: rollup.cycleId, reportKey: snap.productionReportKey, reportVersion: snap.version,
        accountId: snap.accountId, connectionId: "primary", bucket, dependsOn: [],
      });
      await reportLineage.claimReportDerive(rollup.cycleId, snap.productionReportKey, snap.accountId);
      await reportLineage.recordReportSuccess({
        cycleId: rollup.cycleId, reportKey: snap.productionReportKey, accountId: snap.accountId,
        latestDataDate: snap.latestDataDate ?? null, snapshotParamsHash: saved.paramsHash,
      });
    };
    try {
      for (const snap of derived.daily.snapshots) {
        await ensureTime("snapshot-save");
        const saved = await saver({
          reportKey: snap.reportKey, accountId: snap.accountId,
          params: { reportVersion: snap.version, accountId: snap.accountId, from: dailyWindow.from, to: dailyWindow.to, brand: "ALL" },
          payload: snap.payload, sourceRefreshedAt: nowIso(),
        });
        await recordLineage(snap, saved, dailyWindow);
        dailySaved += 1;
      }
      for (const snap of derived.brandView.snapshots) {
        await ensureTime("snapshot-save");
        const saved = await saver({
          reportKey: snap.reportKey, accountId: snap.accountId,
          params: { reportVersion: snap.version, accountId: snap.accountId, from: brandViewWindow.from, to: brandViewWindow.to },
          payload: snap.payload, sourceRefreshedAt: nowIso(),
        });
        await recordLineage(snap, saved, brandViewWindow);
        brandViewSaved += 1;
      }
    } catch (e) { if (e && e[DEADLINE]) return deriveResumable(); throw e; }
    rollup.derived = {
      skipped: null,
      daily: { ready: derived.daily.readiness.ready, adsReady: derived.daily.readiness.adsReady, saved: dailySaved, skipped: derived.daily.skipped },
      brandView: { ready: derived.brandView.readiness.ready, adsReady: derived.brandView.readiness.adsReady, saved: brandViewSaved, skipped: derived.brandView.skipped },
    };
    return rollup;
  };

  // FINDING 8: the fail-closed evidence PREFLIGHT an endpoint runs BEFORE its first write (including the
  // audit row): controls must read ok (migration-unapplied refuses typed) and a paused source refuses
  // BEFORE any discovery/I/O. Returns the paused set for reuse; throws typed on any refusal.
  const preflightEvidence = async ({ bucket = null, sourceKey = null } = {}) => {
    const controls = requireOkRead(await readSourceControls(), "source_controls");
    const pausedSources = new Set((controls.rows || []).filter((r) => r.paused === true).map((r) => r.source_key));
    if (sourceKey != null && pausedSources.has(sourceKey)) {
      const err = new Error(`SOURCE_PAUSED: "${sourceKey}" is paused; resume it before syncing missing data (fail closed).`);
      err.code = "SOURCE_PAUSED";
      err.status = 409;
      throw err;
    }
    // Round-4 finding 4: the COMPLETE evidence sweep -- coverage, snapshots, membership, settings/rollout
    // and schema availability -- so an endpoint can prove EVERY read healthy BEFORE its first write
    // (including the audit row). Any failure below is a typed refusal.
    if (bucket != null) {
      const { connections, orgFingerprint } = resolvePrimary();
      const { accounts } = await discoverBucketAccounts({ connections, bucket });
      for (const a of accounts) {
        requireOkRead(await readCoverage({ organizationFingerprint: orgFingerprint, accountId: a.accountId, sourceKey: OLI_SOURCE_KEY }), `source_coverage(${a.accountId})`);
      }
      requireOkRead(await readSnapshot({ organizationFingerprint: orgFingerprint, connectionId: "primary", sourceKey: CATALOG_SOURCE_KEY, scopeKey: ORGANIZATION_SCOPE_KEY }), "source_snapshots(catalog)");
      for (const a of accounts) {
        requireOkRead(await readSnapshot({ organizationFingerprint: orgFingerprint, connectionId: "primary", sourceKey: FBA_INVENTORY_SOURCE_KEY, scopeKey: a.accountId }), `source_snapshots(fba:${a.accountId})`);
      }
      let membershipRows;
      try { membershipRows = await readBatchMembership(oliBatchFamily({ orgFingerprint, bucket })); }
      catch (_e) {
        const err = new Error("BATCH_MEMBERSHIP_READ_FAILED: durable source_batch_membership could not be read; refusing before any write (fail closed).");
        err.code = "BATCH_MEMBERSHIP_READ_FAILED"; err.status = 503; throw err;
      }
      validateBatchMembershipRows(membershipRows, { orgFingerprint });
      let settings;
      try { settings = await readSettings(); } catch (_e) { settings = null; }
      if (!Array.isArray(settings)) {
        const err = new Error("SETTINGS_READ_FAILED: report_sync_settings could not be read; refusing before any write (fail closed).");
        err.code = "SETTINGS_READ_FAILED"; err.status = 503; throw err;
      }
      const rollout = await (async () => { try { return await readRollout(); } catch (_e) { return null; } })();
      if (!rollout || rollout.read !== "ok") {
        const err = new Error("ROLLOUT_READ_FAILED: the durable account rollout could not be read; refusing before any write (fail closed).");
        err.code = "ROLLOUT_READ_FAILED"; err.status = 503; throw err;
      }
    }
    return { pausedSources };
  };

  const runSourceCardAction = async ({ bucket, sourceKey, reuseOnly = false } = {}) => {
    const entry = sourceRegistryEntry(sourceKey); // typed UNREGISTERED_SOURCE (fail closed)
    if (bucket !== "us" && bucket !== "non-us") {
      throw new Error(`runSourceCardAction requires bucket 'us'|'non-us' (got "${bucket}").`);
    }
    // FINDING 1: controls FIRST for EVERY storage class -- a paused source refuses typed BEFORE any
    // discovery/composition/I-O (run() re-verifies for the durable path; this makes the guarantee uniform).
    await preflightEvidence({ bucket, sourceKey });
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
    // FINDING 1: a cycle-cache family executes ONLY its own canonical source family -- the trusted
    // per-tranche composition FIXED to exactly this family (the full plan is still upserted; execution
    // narrows to the family, so the action can never widen into unrelated dependencies), honoring
    // reuseOnly (the composition installs the create-export tripwire in rehearsal). Bounded continuations
    // under the shared deadline; an expired budget is typed resumable.
    const startMs = clock();
    const deadlineMs = startMs + Number(budgetMs);
    const outOfTime = () => clock() >= deadlineMs - reserveMs;
    const todayStr = new Date(startMs).toISOString().slice(0, 10);
    const asOfStr = addDaysStr(todayStr, -1);
    const runtime = composeTrancheRuntime({ name: sourceKey, sourceKeys: [sourceKey] }, { reuseOnly: reuseOnly === true });
    const store = makeSourceStore();
    const keySet = new Set([sourceKey]);
    const familyState = async (cycleId) => {
      const state = { total: 0, open: 0, succeeded: 0, failed: 0 };
      if (!cycleId) return state;
      for (const r of await store.listSourceJobs(cycleId)) {
        if ((r.source_key ?? r.sourceKey ?? "") !== sourceKey) continue;
        state.total += 1;
        const st = r.fetch_status ?? r.fetchStatus ?? "pending";
        if (st === "pending" || st === "attempted") state.open += 1;
        else if (st === "succeeded") state.succeeded += 1;
        else if (st === "failed") state.failed += 1;
      }
      return state;
    };
    let cycleId = null;
    let state = null;
    let continuations = 0;
    let deadlineReached = false;
    while (continuations < 3) {
      if (outOfTime()) { deadlineReached = true; break; }
      const res = await runtime.run({
        bucket, cycleDate: todayStr, asOf: asOfStr, asOfFor: () => asOfStr,
        manualReportKeys: [...entry.usedByReports],
        clock, deadlineMs, reserveMs, trigger: "manual",
      });
      continuations += 1;
      cycleId = res.cycleId || cycleId;
      state = await familyState(cycleId);
      if (state.open === 0) break;
      if (res.deadlineReached || outOfTime()) { deadlineReached = true; break; }
      if ((res.spent || 0) === 0) break; // no progress possible this invocation (e.g. rollout selects nothing)
    }
    return {
      refused: false, architecture: "tranche", sourceKey, bucket, cycleId,
      familyState: state, continuations,
      deadlineReached, continuationRequired: deadlineReached || (state ? state.open > 0 : false),
      _usedTrancheKeys: keySet.size, // structural: exactly one family selected
    };
  };

  const gatherDurableReadiness = async ({ bucket, accounts, asOf = null } = {}) => {
    if (bucket !== "us" && bucket !== "non-us") throw new Error("gatherDurableReadiness requires bucket 'us'|'non-us' (fail closed).");
    const bound = (accounts || []).filter((a) => a && a.accountId && !String(a.accountId).includes(":"));
    const ids = bound.map((a) => String(a.accountId));
    const { orgFingerprint } = resolvePrimary();
    const todayStr = new Date(clock()).toISOString().slice(0, 10);
    const asOfStr = asOf || addDaysStr(todayStr, -1);
    const evidence = await gatherEvidence({ orgFingerprint, accounts: ids.map((accountId) => ({ accountId })), today: todayStr });
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

  return { run, runSourceCardAction, gatherDurableReadiness, preflightEvidence };
}
