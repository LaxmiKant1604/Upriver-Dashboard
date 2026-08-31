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
import { runBucketSourceSync, SOURCE_SYNC_OWNER_REPORT_KEY, selectCatalogCarrierSeller } from "./source-bucket-sync.js";
import { REPORT_SOURCE_CONTRACTS } from "./report-source-contracts.js";
import {
  OLI_SOURCE_KEY, CATALOG_SOURCE_KEY, FBA_INVENTORY_SOURCE_KEY, ORGANIZATION_SCOPE_KEY,
  oliBackfillWindow, snapshotRefreshDecision, resolveEffectivePublishAsOf,
} from "./source-durable-model.js";
import { SOURCE_REGISTRY, sourceRegistryEntry } from "./source-registry.js";
import {
  deriveDurableDashboardSnapshots, DAILY_ADS_GRAIN, BRAND_VIEW_ADS_GRAIN,
  dailyReportingReadiness, brandViewReadiness,
} from "./durable-dashboards.js";
import { shadowSnapshotKey, REPORT_DERIVATIONS } from "./report-derivation.js";
import { buildBrandInventorySnapshot, BRAND_INVENTORY_SNAPSHOT_KEY, BRAND_INVENTORY_REPORT_VERSION } from "../reports/brand-view.js";
import {
  getSourceControls, getSourceCoverageWindows, getSourceSnapshot,
  recordSourceSnapshot, upsertSourceRunStatus,
  replaceOliHistoryWindow, replaceOliDimensionalWindow, recordOliCompleteness, saveSourceSnapshotPayload, getSourceSnapshotPayload,
  getSourceOliHistoryRows, getDailyAdsCoverage, getAsinAdsDailyRows,
  getSourceOliOperationalUnitRows, getSourceOliDimensionalUnitRows, getSourceOliSalesEstimateRows, replaceOliSalesEstimatesWindow, getOliSkuAsinResolutionRows,
  listSourceBatchMembership, assignSourceAccountBatch,
  getReportSyncSettings, getSchedulerAccountRollout,
  upsertSyncReportJob, claimReportDeriveLease, reconcileReportDeriveSuccess, getReportSnapshot,
  getReportSnapshotStoragePayload, saveShadowSnapshotIfNewer,
} from "../supabase.js";
import { recomputeOliSalesEstimatesWindow } from "./oli-sales-estimate-recompute.js";
import {
  enrichOliHistoryRowsWithEstimates,
  resolveUniqueMarketplaceByAccount, authoritativeMarketplace, summarizeMarketplaceResolution,
  OLI_ESTIMATE_MARKETPLACE_MISSING, OLI_ESTIMATE_MARKETPLACE_AMBIGUOUS,
} from "./oli-sales-estimate.js";
import { enrichOrderedOliHistory } from "./oli-enriched-history.js";
import { paramsHashFor } from "../report-store.js";
import { assertSnapshotWithinLimit } from "../report-limits.js";

// Round-8 finding 2: a stable canonical JSON so a durable snapshot's content can be proven byte-identical to
// the freshly derived candidate regardless of key insertion order (arrays keep order; objects sort keys).
function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
  }
  return JSON.stringify(value === undefined ? null : value);
}

export { SOURCE_SYNC_OWNER_REPORT_KEY };

export const DEFAULT_ROUTE_BUDGET_MS = 50_000; // under config.maxDuration = 60 with reserve headroom
export const DEFAULT_ROUTE_RESERVE_MS = 5_000;

// Mirrors the LIVE compact Brand View inventory contract (api/datadoe.js PLAN_INVENTORY_LOOKBACK_DAYS /
// PLAN_INVENTORY_ROW_LIMIT): the exact [asOf-10d .. asOf] fold window and the truncation-refusal cap.
const BRAND_INVENTORY_LOOKBACK_DAYS = 10;
const BRAND_INVENTORY_ROW_LIMIT = 15000;

// Round-5 blocker 4: ONE route-owned deadline. Symbol.for so a deadline created by the route and checked by
// the runtime share the SAME marker even across module instances.
const ROUTE_DEADLINE = Symbol.for("scheduler-v2/route-deadline");

/**
 * Round-5 blocker 4: the reviewed route-owned deadline wrapper. Created by the ROUTE **before** preflight and
 * threaded (as `deadline`) through preflight + execution, so preflight time genuinely counts against the one
 * route budget. Beyond checkpoint expiry (`ensureTime`), `bound(phase, op)` bounds an IN-FLIGHT operation:
 * the op receives an AbortSignal (aborted on expiry) and is raced against the remaining budget via the
 * injectable timer, so even a collaborator that ignores the signal returns control before the route dies.
 * Expiry errors are TYPED (code ROUTE_DEADLINE_EXCEEDED, status 503) and carry the phase under the shared
 * ROUTE_DEADLINE marker so the runtime converts them into typed-resumable rollups.
 */
export function makeRouteDeadline({
  clock = () => Date.now(),
  budgetMs = DEFAULT_ROUTE_BUDGET_MS,
  reserveMs = DEFAULT_ROUTE_RESERVE_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  const startMs = clock();
  const deadlineMs = startMs + Number(budgetMs);
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const abort = () => { if (controller && !controller.signal.aborted) controller.abort(); };
  const outOfTime = () => clock() >= deadlineMs - reserveMs;
  // Round-6 fix 4: THREE typed expiry outcomes, never conflated:
  //   beforeRequest -- the budget expired BEFORE the operation was invoked: PROVEN zero effect;
  //   inFlight      -- the operation's HTTP was aborted (or its promise abandoned) MID-FLIGHT. For a READ
  //                    this is safe; for a WRITE the database may ALREADY HAVE COMMITTED, so the error
  //                    carries commitUnknown:true and no caller may claim the write did not happen --
  //                    resumption relies on the idempotent replay design (upserts, one-create-per-hash,
  //                    CAS), never on an uncommitted assumption;
  //   (a write that RETURNED before expiry is a confirmed durable completion and is reported as success.)
  const expiry = (phase, { beforeRequest = false, inFlight = false, write = false } = {}) => {
    const e = new Error(`ROUTE_DEADLINE_EXCEEDED: the route budget expired ${beforeRequest ? "before" : "during"} ${phase}; the work is typed-resumable on a fresh invocation${write && inFlight ? " (in-flight write: commit UNKNOWN; the replay design is idempotent)" : ""}.`);
    e.code = "ROUTE_DEADLINE_EXCEEDED";
    e.status = 503;
    e[ROUTE_DEADLINE] = phase;
    e.beforeRequest = beforeRequest;
    e.inFlight = inFlight;
    e.commitUnknown = !!(write && inFlight);
    return e;
  };
  const ensureTime = async (phase) => { if (outOfTime()) { abort(); throw expiry(phase, { beforeRequest: true }); } };
  const bound = async (phase, op, { write = false } = {}) => {
    // Before-request expiry: the op is NEVER invoked -- zero HTTP, zero writes.
    if (outOfTime()) { abort(); throw expiry(phase, { beforeRequest: true, write }); }
    const signal = controller ? controller.signal : null;
    if (typeof setTimer !== "function") return op(signal);
    const remaining = Math.max(1, deadlineMs - reserveMs - clock());
    let timerId = null;
    let timedOut = false;
    const timeout = new Promise((resolve) => { timerId = setTimer(() => { timedOut = true; abort(); resolve(null); }, remaining); });
    const opPromise = Promise.resolve().then(() => op(signal)).then((v) => ({ v }));
    try {
      const winner = await Promise.race([opPromise, timeout]);
      if (winner == null || timedOut) {
        opPromise.catch(() => {}); // the abandoned in-flight op may still reject later; never unhandled
        throw expiry(phase, { inFlight: true, write });
      }
      return winner.v;
    } finally {
      if (timerId != null && typeof clearTimer === "function") clearTimer(timerId);
    }
  };
  return {
    startMs, deadlineMs, reserveMs,
    signal: controller ? controller.signal : null,
    aborted: () => !!(controller && controller.signal.aborted),
    outOfTime, ensureTime, bound,
    elapsed: () => clock() - startMs,
    isDeadlineError: (e) => !!(e && e[ROUTE_DEADLINE]),
    phaseOf: (e) => (e && e[ROUTE_DEADLINE]) || null,
  };
}

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
    // Daily Reporting reads the durable ASIN grain (asin-performance-v1) -- the SINGLE reusable Ads source,
    // shared with Brand View. (Was getAdDailyMetrics / the campaign grain, now PPC-only.)
    readAdMetrics = getAsinAdsDailyRows,
    readBatchMembership = listSourceBatchMembership,
    assignBatchMembership = assignSourceAccountBatch,
    readSettings = getReportSyncSettings,
    readRollout = getSchedulerAccountRollout,
    // Round-4 finding 3 + round-7 finding 1: the GENUINE, RECOVERABLE publication lineage. Every durable
    // shadow save records a real sync_report_jobs row via a DURABLE LEASE (claimLease) and a guarded
    // RECONCILE bound to the exact durable snapshot identity (reconcileSuccess), so a commitUnknown mid-derive
    // is recoverable without stealing a live worker's claim, re-exporting from DataDoe, or fabricating success.
    reportLineage = { upsertReportJob: upsertSyncReportJob, claimLease: claimReportDeriveLease, reconcileSuccess: reconcileReportDeriveSuccess },
    // The EXACT-identity durable shadow-snapshot read used to adopt an already-saved snapshot on recovery
    // (a shadow-save commit-unknown left it durable) so recovery re-saves ONLY when it is genuinely absent.
    readShadowSnapshot = getReportSnapshot,
    // Round-8 finding 2: the trusted storage hydrator for a storage-backed durable snapshot payload, used to
    // validate a recovered snapshot's CONTENT before adoption (a dangling/unreadable object fails closed).
    loadShadowStoragePayload = getReportSnapshotStoragePayload,
    // Round-9 finding 4: the reviewed atomic freshness/CAS save for a shadow snapshot (a legitimate same-
    // params refresh replaces older evidence atomically; older/equal-conflicting preserves LKG).
    saveShadowIfNewer = saveShadowSnapshotIfNewer,
    composeTrancheRuntime = buildSchedulerV2SourceTrancheRuntime,
    // OLI persistence now goes through the DIMENSIONAL RPC: it writes the full-grain evidence (cancelled
    // included, for audit) AND the non-cancelled daily rollup into source_oli_daily_history (what dashboards
    // read) atomically. The value-missing / status-missing refusals are surfaced typed so a bad account keeps
    // its LKG.
    replaceHistory = replaceOliDimensionalWindow,
    saveSnapshotPayload = saveSourceSnapshotPayload,
    loadSnapshotPayload = getSourceSnapshotPayload,
    recordSnapshot = recordSourceSnapshot,
    loadHistoryRows = getSourceOliHistoryRows,
    // OLI SALES ESTIMATE (ADDITIVE, ZERO DataDoe): after each OLI persist, recompute the internal missing/zero-price
    // sales estimates from durable truth (operational units + dimensional references) and enrich the derive's Total
    // Sales. Build-time bound (never a run() arg); fully NON-FATAL at the call site so the priced Total Sales + LKG
    // are never regressed. Fail-soft pre-migration (the estimate reader/writer degrade to no-op).
    // enableSalesEstimates gates the whole additive estimate step. Default OFF so a bare runtime (readiness reads,
    // offline harnesses) NEVER touches the estimate tables; the production priority-release composition turns it ON.
    enableSalesEstimates = false,
    recomputeSalesEstimates = recomputeOliSalesEstimatesWindow,
    readOperationalUnitsForEstimate = getSourceOliOperationalUnitRows,
    readDimensionalRowsForEstimate = getSourceOliDimensionalUnitRows,
    readSkuAsinResolutionForEstimate = getOliSkuAsinResolutionRows,
    readSalesEstimates = getSourceOliSalesEstimateRows,
    writeSalesEstimates = replaceOliSalesEstimatesWindow,
    enrichHistoryWithEstimates = enrichOliHistoryRowsWithEstimates,
    enrichOrderedHistory = enrichOrderedOliHistory,
    updateRunStatus = upsertSourceRunStatus,
    makeShadowSaver = makeShadowSnapshotSaver,
    clock = () => Date.now(),
    budgetMs = DEFAULT_ROUTE_BUDGET_MS,
    reserveMs = DEFAULT_ROUTE_RESERVE_MS,
    // TRUSTED, BUILD-TIME-ONLY priority-dashboards binding (mirrors recoverFailedDownloads): when true, EVERY
    // run() on this runtime is a Daily Reporting + Brand View priority derive (pause every non-catalog source,
    // force the Catalog job, derive off durable OLI + Catalog, represent missing Ads/FBA as unavailable).
    // Ordinary runtime callers -- HTTP routes, card actions, the scheduler -- build the runtime with no
    // arguments and get priorityMode=false; there is NO run() argument to flip it. Only the reviewed
    // source-priority-dashboards release composition sets it true, alongside its catalog-only durable create
    // guard. run() therefore has no freely-selectable priority switch.
    priorityMode = false,
    // TRUSTED, BUILD-TIME-ONLY asOf pin (YYYY-MM-DD). When set, the derive window's `to` (asOf) is this exact
    // date instead of clock today-1. The priority go-live uses it to derive up to the LAST PROVEN durable-OLI
    // covered_to day when the wall clock has drifted past it (no new OLI fetch). Ordinary callers leave it null
    // and get clock today-1. Bound at BUILD time (never a run() arg); only the reviewed release composition sets
    // it, and the cycle date stays clock-today, so ONLY the derive window narrows.
    asOfOverride = null,
    // Round-7 finding 1: the derive-lease duration. Long enough that a live worker (bounded by the ~50s
    // route budget) always holds a non-expired lease within its invocation, short enough that a genuinely
    // abandoned claim recovers on a later invocation. NEVER derived from updated_at.
    reportDeriveLeaseSeconds = 300,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
  } = overrides;

  // Round-5 blocker 4: ONE route-owned deadline threads through preflight + execution. A route creates it
  // BEFORE preflight via makeDeadline(); when none is provided (direct run() callers, the scheduler), the
  // runtime creates its own with the same clock/budget so nothing ever runs unbounded.
  const makeDeadline = (opts = {}) => makeRouteDeadline({ clock, budgetMs, reserveMs, setTimer, clearTimer, ...opts });
  const resolveDeadline = (deadline) => (deadline && typeof deadline.ensureTime === "function" && typeof deadline.bound === "function" ? deadline : makeDeadline());

  // FINDINGS 5 + 6 + round-6 fix 2: the collaborator the bucket sync calls with ROWS -- production copies
  // them into the ORGANIZATION/CONNECTION-scoped, CONTENT-ADDRESSED source-snapshots/* namespace (immutable
  // objects the cache prune can never touch), then records the pointer WITH the content hash. The CAS
  // acknowledgement DECIDES what evidence is AUTHORITATIVE afterwards:
  //   replaced   -- the candidate won the pointer: the candidate IS the authoritative evidence;
  //   unchanged  -- the CAS proved the existing pointer holds the IDENTICAL content (same content-addressed
  //                 payload_sha AND object path): the candidate content is byte-identical to the winner;
  //   stale-save -- a NEWER concurrent save won: the candidate is a CAS LOSER and must NEVER feed
  //                 derivation. The WINNING pointer is re-read and its payload hydrated through the
  //                 hash-proving loader; an unreadable/invalid winner fails CLOSED typed (LKG preserved);
  //   conflict / malformed acknowledgements -- the wrapper throws typed before this returns (fail closed).
  // Returns { write:"ok", ack, objectPath, authoritativeRows, authoritativeSnapshot } -- callers fold ONLY
  // the authoritative side into evidence, never the losing candidate.
  const makePersistSnapshot = (orgFingerprint, dl = null) => async ({ sourceKey, scopeKey, rows, rowCount, sourceRequestHash, validatedAt, signal = null }) => {
    const sig = signal || (dl ? dl.signal : null);
    const ghostGuard = (phase) => {
      // Round-6 fix 4: an aborted/expired route may never trigger the SUBSEQUENT durable write from an
      // abandoned promise chain. The step that has not started is PROVEN not to have happened.
      if (sig && sig.aborted) {
        const e = new Error(`ROUTE_DEADLINE_EXCEEDED: the route budget expired before ${phase}; the remaining persistence steps did not run (fail closed; typed-resumable).`);
        e.code = "ROUTE_DEADLINE_EXCEEDED";
        e.status = 503;
        e[ROUTE_DEADLINE] = phase;
        e.beforeRequest = true;
        e.inFlight = false;
        e.commitUnknown = false;
        throw e;
      }
    };
    const saved = await saveSnapshotPayload({ organizationFingerprint: orgFingerprint, connectionId: "primary", sourceKey, scopeKey, rows, signal: sig });
    ghostGuard("snapshot-pointer-write");
    const outcome = await recordSnapshot({
      organizationFingerprint: orgFingerprint, connectionId: "primary",
      sourceKey, scopeKey, objectPath: saved.objectPath, payloadSha: saved.payloadSha, rowCount,
      payloadBytes: saved.payloadBytes, sourceRequestHash, validatedAt, signal: sig,
    });
    const ack = outcome && outcome.write === "ok" ? outcome.ack : null;
    if (ack !== "replaced" && ack !== "unchanged" && ack !== "stale-save") {
      const err = new Error(`SOURCE_SNAPSHOT_ACK_INVALID: persistSnapshot requires a typed CAS acknowledgement (got ${JSON.stringify(ack)}); the save is unacknowledged (fail closed).`);
      err.code = "SOURCE_SNAPSHOT_ACK_INVALID";
      err.status = 503;
      throw err;
    }
    if (ack === "replaced" || ack === "unchanged") {
      return {
        write: "ok", ack, objectPath: saved.objectPath,
        authoritativeRows: rows,
        authoritativeSnapshot: { validated_at: validatedAt, object_path: saved.objectPath, row_count: rowCount },
      };
    }
    // stale-save: a NEWER save owns the pointer. Hydrate + validate the WINNER; the losing candidate is
    // dropped here and can never reach derivation or a report save.
    ghostGuard("stale-winner-hydration");
    const winRead = await readSnapshot({ organizationFingerprint: orgFingerprint, connectionId: "primary", sourceKey, scopeKey, signal: sig });
    const winner = winRead && winRead.read === "ok" ? winRead.snapshot : null;
    let winnerRows = null;
    if (winner && winner.object_path) {
      try {
        const payload = await loadSnapshotPayload(winner.object_path, { signal: sig });
        winnerRows = payload && Array.isArray(payload.rows) && payload.rows.length === Number(winner.row_count) ? payload.rows : null;
      } catch (e) {
        if (e && e[ROUTE_DEADLINE]) throw e;
        winnerRows = null;
      }
    }
    if (!winnerRows) {
      const err = new Error("SOURCE_SNAPSHOT_STALE_WINNER_UNREADABLE: a newer concurrent save won the pointer CAS but its durable evidence could not be hydrated/validated; stopping typed (latest-good preserved; nothing derives from the losing candidate).");
      err.code = "SOURCE_SNAPSHOT_STALE_WINNER_UNREADABLE";
      err.status = 503;
      throw err;
    }
    return { write: "ok", ack: "stale-save", objectPath: winner.object_path, authoritativeRows: winnerRows, authoritativeSnapshot: winner };
  };

  // Deep-enough copy of a memoized preflight bundle's evidence: the run folds the sync's own products into
  // these containers in-memory and must never corrupt the caller's bundle.
  const cloneEvidence = (pf) => ({
    readBlockers: [...(pf.evidence.readBlockers || [])],
    oliCoverageByAccountId: Object.fromEntries(Object.entries(pf.evidence.oliCoverageByAccountId || {}).map(([k, v]) => [k, [...(v || [])]])),
    catalogSnapshot: pf.evidence.catalogSnapshot,
    catalogRows: pf.evidence.catalogRows,
    fbaSnapshotsByAccount: { ...(pf.evidence.fbaSnapshotsByAccount || {}) },
    fbaRowsByAccount: { ...(pf.evidence.fbaRowsByAccount || {}) },
    campaignCoverageStateByAccountId: pf.evidence.campaignCoverageStateByAccountId,
    asinCoverageStateByAccountId: pf.evidence.asinCoverageStateByAccountId,
    campaignAds: pf.evidence.campaignAds,
    asinAds: pf.evidence.asinAds,
    historyRows: [...(pf.historyRows || [])],
  });

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
    // The Catalog carrier seller is chosen from the FULL primary directory (not this bucket), so US + Non-US
    // deterministically pick the SAME carrier => one canonical Catalog request hash across both buckets.
    return { ...bindPrimaryBucketAccounts(active, bucket), catalogCarrierSeller: selectCatalogCarrierSeller(active) };
  };

  // FINDINGS 7 + 8: authoritative per-account evidence gathering. Read failures become TYPED blocked
  // entries (never a fabricated "ready", never a 500). Snapshot evidence is validated for freshness policy
  // (stale => typed degrade), exact ISOLATED identity (the read itself is org/connection-keyed), storage
  // HYDRATION (a dangling pointer blocks), row-count INTEGRITY, and content-hash provenance (the hydrator
  // proves payload<->metadata). Hydrated catalog rows are returned for the derive stage.
  const gatherEvidence = async ({ orgFingerprint, accounts, today = null, ensureTime = null, bound = null }) => {
    const tick = async (label) => { if (ensureTime) await ensureTime(label); };
    // Round-5 blocker 4: when a route deadline is threaded in, every read is BOUNDED in-flight (raced
    // against the remaining budget + abortable), not merely checkpointed between reads.
    const call = async (label, fn) => { if (bound) return bound(label, fn); await tick(label); return fn(); };
    const readBlockers = [];
    const oliCoverageByAccountId = {};
    for (const a of accounts) {
      const cov = await call("coverage-read", (signal) => readCoverage({ organizationFingerprint: orgFingerprint, accountId: a.accountId, sourceKey: OLI_SOURCE_KEY, signal }));
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
      let rows = null;
      try {
        const payload = await call("snapshot-hydration", (signal) => loadSnapshotPayload(snapshot.object_path, { signal }));
        rows = payload.rows;
      } catch (e) {
        if (e && e[ROUTE_DEADLINE]) throw e; // a deadline expiry is resumable, never "dangling" evidence
        readBlockers.push({ sourceKey, accountId, reason: "snapshot-dangling", blocksSales });
        return { snapshot: null, rows: null };
      }
      if (rows.length !== Number(snapshot.row_count)) {
        readBlockers.push({ sourceKey, accountId, reason: "snapshot-integrity", blocksSales });
        return { snapshot: null, rows: null };
      }
      return { snapshot, rows };
    };
    const catalogRead = await call("catalog-snapshot-read", (signal) => readSnapshot({ organizationFingerprint: orgFingerprint, connectionId: "primary", sourceKey: CATALOG_SOURCE_KEY, scopeKey: ORGANIZATION_SCOPE_KEY, signal }));
    const catalog = await validateSnapshot({ snapRead: catalogRead, sourceKey: CATALOG_SOURCE_KEY, blocksSales: true });
    const fbaSnapshotsByAccount = {};
    const fbaRowsByAccount = {}; // Round-5 blocker 2: the HYDRATED durable FBA rows feed the compact Brand View inventory
    for (const a of accounts) {
      const snapRead = await call("fba-snapshot-read", (signal) => readSnapshot({ organizationFingerprint: orgFingerprint, connectionId: "primary", sourceKey: FBA_INVENTORY_SOURCE_KEY, scopeKey: a.accountId, signal }));
      const fba = await validateSnapshot({ snapRead, sourceKey: FBA_INVENTORY_SOURCE_KEY, accountId: a.accountId, blocksSales: false });
      if (fba.snapshot) {
        fbaSnapshotsByAccount[a.accountId] = fba.snapshot;
        fbaRowsByAccount[a.accountId] = fba.rows;
      }
    }
    const campaignWindows = {};
    const asinWindows = {};
    const campaignCoverageStateByAccountId = {};
    const asinCoverageStateByAccountId = {};
    for (const a of accounts) {
      // Campaign-grain coverage is still read for PPC diagnostics/read-blockers (PPC reads both grains).
      const camp = await call("ads-coverage-read", (signal) => readAdsCoverage(a.accountId, "campaign-performance-v1", { signal }));
      campaignCoverageStateByAccountId[a.accountId] = camp;
      campaignWindows[a.accountId] = camp.read === "ok" ? camp.windows : null;
      if (camp.read !== "ok") readBlockers.push({ sourceKey: "ads-campaign-date", accountId: a.accountId, reason: "ads-coverage-" + camp.read, blocksSales: false });
      // ASIN-grain coverage is the AUTHORITATIVE Daily + Brand View Ads coverage (the single reusable source).
      const asin = await call("ads-coverage-read", (signal) => readAdsCoverage(a.accountId, "asin-performance-v1", { signal }));
      asinCoverageStateByAccountId[a.accountId] = asin;
      asinWindows[a.accountId] = asin.read === "ok" ? asin.windows : null;
      if (asin.read !== "ok") readBlockers.push({ sourceKey: "ads-asin-date", accountId: a.accountId, reason: "ads-coverage-" + asin.read, blocksSales: false });
    }
    return {
      readBlockers, oliCoverageByAccountId,
      catalogSnapshot: catalog.snapshot,
      catalogRows: catalog.rows,
      fbaSnapshotsByAccount,
      fbaRowsByAccount,
      campaignCoverageStateByAccountId,
      asinCoverageStateByAccountId,
      campaignAds: { grain: "campaign-performance-v1", read: "ok", windowsByAccountId: Object.fromEntries(Object.entries(campaignWindows).map(([k, v]) => [k, v || []])) },
      asinAds: { grain: BRAND_VIEW_ADS_GRAIN, read: "ok", windowsByAccountId: Object.fromEntries(Object.entries(asinWindows).map(([k, v]) => [k, v || []])) },
    };
  };

  const run = async ({ bucket, asOf = null, today = null, cycleDate = null, reuseOnly = false, onlySourceKey = null, deadline = null, preflight = null, forceFreshOli = false } = {}) => {
    if (bucket !== "us" && bucket !== "non-us") {
      throw new Error(`buildBucketSourceSyncRuntime.run requires bucket 'us'|'non-us' (got "${bucket}").`);
    }
    // Priority mode is BOUND AT BUILD TIME only (see priorityMode above) -- never a run() argument, so no
    // ordinary caller can activate the derive-off-durable + non-catalog-pause behaviour by passing a flag.
    const priority = priorityMode === true;
    if (onlySourceKey != null) sourceRegistryEntry(onlySourceKey); // typed UNREGISTERED_SOURCE (fail closed)
    if (preflight && preflight.bucket !== bucket) {
      throw new Error(`PREFLIGHT_SCOPE_MISMATCH: the memoized preflight was gathered for bucket "${preflight && preflight.bucket}", not "${bucket}" (fail closed).`);
    }
    // FINDING 3 + round-5 blocker 4: ONE ROUTE-OWNED deadline. The route creates it BEFORE preflight and
    // threads the SAME object here, so preflight time counts against the one budget; a direct caller gets a
    // fresh bounded one (never Infinity under the route). Expiry BEFORE/DURING a phase returns typed
    // RESUMABLE state; in-flight reads/writes are additionally bounded via dl.bound (abort + race).
    const dl = resolveDeadline(deadline);
    const outOfTime = dl.outOfTime;
    const ensureTime = dl.ensureTime;
    // Round-6 fix 4: an in-flight WRITE expiry carries commitUnknown -- the resumable rollup reports it
    // honestly (the write may have committed; the replay design is idempotent) instead of implying nothing
    // happened.
    const resumable = (phase, cause = null) => ({ bucket, deadlineReached: true, continuationRequired: true, stopped: false, phase, skipped: "deadline", commitUnknown: !!(cause && cause.commitUnknown) });
    const catchDeadline = (e) => { if (dl.isDeadlineError(e)) return resumable(dl.phaseOf(e), e); throw e; };

    // FINDING 1: controls FIRST -- an unapplied migration or failed read refuses BEFORE discovery. Round-5
    // blocker 3: with a memoized preflight, the controls ALREADY read there are consumed -- never re-read.
    let pausedSources;
    try {
      if (preflight) {
        pausedSources = new Set(preflight.pausedSources);
      } else {
        const controls = requireOkRead(await dl.bound("controls-read", (signal) => readSourceControls({ signal })), "source_controls");
        pausedSources = new Set((controls.rows || []).filter((r) => r.paused === true).map((r) => r.source_key));
      }
    } catch (e) { return catchDeadline(e); }
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
    // PRIORITY DASHBOARDS PATH (Daily Reporting + Brand View): derive ONLY from the PROVEN durable OLI history
    // + the organization Catalog. Pause every non-catalog source so this run plans ZERO OLI/Ads/FBA/other
    // exports (structurally, not by configuration); the catalog family is force-planned (below, via
    // forceCatalogRefresh) so the cycle drains and the durable-evidence derive/save runs even when the durable
    // OLI needs no new fetch. Missing Ads/FBA are represented as UNAVAILABLE downstream (daily runs sales-only;
    // brand-inventory yields inventoryAvailable:false). The trusted operator additionally guards the adapter so
    // at most ONE Catalog export (<=2 tokens) can ever be created across the whole go-live.
    if (priority) {
      if (pausedSources.has(CATALOG_SOURCE_KEY)) {
        const err = new Error(`SOURCE_PAUSED: "${CATALOG_SOURCE_KEY}" is paused; the priority dashboards path needs the Catalog source enabled (fail closed).`);
        err.code = "SOURCE_PAUSED";
        err.status = 409;
        throw err;
      }
      for (const entry of SOURCE_REGISTRY) {
        if (entry.sourceKey !== CATALOG_SOURCE_KEY) pausedSources.add(entry.sourceKey);
      }
    }

    let connections; let primary; let orgFingerprint; let accounts; let excluded; let catalogCarrierSeller;
    if (preflight) {
      // Round-5 blocker 3: the memoized preflight discovery IS the discovery -- never repeated in execution.
      ({ connections, primary, orgFingerprint, accounts, excluded, catalogCarrierSeller } = preflight);
    } else {
      ({ connections, primary, orgFingerprint } = resolvePrimary());
      try {
        const discovered = await dl.bound("discovery", () => discoverBucketAccounts({ connections, bucket }));
        accounts = discovered.accounts;
        excluded = discovered.excluded;
        catalogCarrierSeller = discovered.catalogCarrierSeller;
      } catch (e) { return catchDeadline(e); }
    }
    if (!accounts.length) {
      return { bucket, skipped: "no-bucket-accounts", accounts: 0, excludedAccounts: excluded };
    }

    // FINDING 1: evidence reads fail closed BEFORE any cycle/store/DataDoe work. FINDING 2: each read is
    // deadline-checked AND bounded in-flight; expiry returns typed resumable state. Round-5 blocker 3: with
    // a memoized preflight the HYDRATED, staleness-validated evidence gathered there is consumed directly --
    // no coverage/snapshot read is repeated -- and the sync's own persisted products are folded back into it
    // below so the derive stage reflects THIS invocation's fetches with zero repeated reads.
    const coverageByAccountId = {};
    let catalogSnapForSync = null;
    const fbaSnapshotsForSync = {};
    let liveEvidence = null;
    if (preflight) {
      liveEvidence = cloneEvidence(preflight);
      for (const a of accounts) coverageByAccountId[a.accountId] = [...(liveEvidence.oliCoverageByAccountId[a.accountId] || [])];
      // Stale/dangling evidence was DROPPED by the preflight validator, so a stale catalog/FBA snapshot
      // correctly presents as absent here and the sync plans its refresh.
      catalogSnapForSync = liveEvidence.catalogSnapshot;
      Object.assign(fbaSnapshotsForSync, liveEvidence.fbaSnapshotsByAccount);
    } else {
      try {
        for (const a of accounts) {
          const cov = requireOkRead(
            await dl.bound("evidence-coverage", (signal) => readCoverage({ organizationFingerprint: orgFingerprint, accountId: a.accountId, sourceKey: OLI_SOURCE_KEY, signal })),
            `source_coverage(${a.accountId})`,
          );
          coverageByAccountId[a.accountId] = cov.windows;
        }
        const catalogSnap = requireOkRead(await dl.bound("evidence-snapshots", (signal) => readSnapshot({ organizationFingerprint: orgFingerprint, connectionId: "primary", sourceKey: CATALOG_SOURCE_KEY, scopeKey: ORGANIZATION_SCOPE_KEY, signal })), "source_snapshots(catalog)");
        catalogSnapForSync = catalogSnap.snapshot;
        for (const a of accounts) {
          const snap = requireOkRead(await dl.bound("evidence-snapshots", (signal) => readSnapshot({ organizationFingerprint: orgFingerprint, connectionId: "primary", sourceKey: FBA_INVENTORY_SOURCE_KEY, scopeKey: a.accountId, signal })), `source_snapshots(fba:${a.accountId})`);
          if (snap.snapshot) fbaSnapshotsForSync[a.accountId] = snap.snapshot;
        }
      } catch (e) { return catchDeadline(e); }
    }

    // FINDING 7: durable, transactionally-assigned stable batch membership (never recomputed ad hoc);
    // FINDING 6: every loaded row is validated (canonical account / connection / organization / index /
    // uniqueness / <=5) before it may seed a plan. With a memoized preflight the VALIDATED membership from
    // the preflight read is consumed (copied); only the ASSIGNMENT (a write) still runs here.
    const batchFamily = oliBatchFamily({ orgFingerprint, bucket });
    let existingMembership;
    if (preflight) {
      existingMembership = new Map(preflight.membership);
    } else {
      let membershipRows;
      try {
        membershipRows = await dl.bound("membership-read", (signal) => readBatchMembership(batchFamily, { signal }));
      } catch (e) {
        if (dl.isDeadlineError(e)) return resumable(dl.phaseOf(e));
        const err = new Error("BATCH_MEMBERSHIP_READ_FAILED: durable source_batch_membership could not be read; refusing before any export (fail closed).");
        err.code = "BATCH_MEMBERSHIP_READ_FAILED";
        err.status = 503;
        throw err;
      }
      existingMembership = validateBatchMembershipRows(membershipRows, { orgFingerprint });
    }
    try {
      for (const a of accounts) {
        if (existingMembership.has(a.accountId)) continue;
        const idx = await dl.bound("membership-assign", (signal) => assignBatchMembership({ batchFamily, accountId: a.accountId, connectionId: "primary", organizationFingerprint: orgFingerprint, signal }), { write: true });
        if (!Number.isInteger(idx) || idx < 0) {
          const err = new Error("BATCH_MEMBERSHIP_ASSIGN_FAILED: transactional batch assignment returned a malformed index; refusing (fail closed).");
          err.code = "BATCH_MEMBERSHIP_ASSIGN_FAILED";
          throw err;
        }
        existingMembership.set(a.accountId, idx);
      }
    } catch (e) { return catchDeadline(e); }

    const todayStr = today || (preflight && preflight.today) || new Date(clock()).toISOString().slice(0, 10);
    // the latest COMPLETED day (conservative for manual runs); a build-time asOfOverride pins it to the last
    // proven durable-OLI covered_to day when the wall clock has drifted past it (cycle date stays clock-today).
    const asOfStr = asOf || asOfOverride || addDaysStr(todayStr, -1);
    const store = makeSourceStore({ deadline: dl });
    const dataDoe = makeAdapter(connections);

    // TERMINAL-CYCLE IDEMPOTENCE (ordinary path only): the day's cycle being terminal means the day's operation
    // already completed -- the reviewed RPCs refuse to append/alter child work on it, so re-running the sync
    // MUST short-circuit typed (refused:false, no continuation => the caller proceeds to its release/read-back
    // phase) instead of crashing mid-derive on the RPC refusal. The priority release engine keeps its own
    // already-terminal handling (deriveBucket short-circuit + finalize re-proof) and never takes this branch.
    // The by-date read is an OPTIONAL store capability (the production store provides it; a double without it
    // skips the pre-check and keeps its legacy behavior byte-identical).
    if (!priority && typeof store.getCycleByBucketDate === "function") {
      try {
        const existing = await dl.bound("cycle-terminal-precheck", (signal) => store.getCycleByBucketDate(bucket, cycleDate || todayStr, { signal }));
        // Short-circuit ONLY for a genuinely TERMINAL active head (succeeded/partial/failed) -- the day's operation
        // completed and the RPCs refuse to append to it. A RUNNING or PENDING head must proceed: a pending head is a
        // fresh base cycle OR a superseding attempt an operator just opened to take over a stale terminal slot; it
        // still needs to be claimed + fetched. (Before this fix a pending superseding attempt was wrongly treated as
        // terminal and skipped, so the fresh D-1 re-fetch never ran.)
        if (existing && existing.id && ["succeeded", "partial", "failed"].includes(String(existing.status))) {
          return {
            bucket, cycleId: existing.id, cycleStatus: existing.status,
            alreadyTerminal: true, skipped: "cycle-terminal",
            globalDrained: true, continuationRequired: false, accounts: accounts.length,
          };
        }
      } catch (e) { return catchDeadline(e); }
    }

    // Round-5 blocker 3 + round-6 fixes 2/4: when running on a memoized preflight, the sync's OWN durable
    // products are folded into the in-memory evidence -- but ONLY the CAS-AUTHORITATIVE side (the winner on
    // stale-save, the candidate only when it replaced or was proven identical), ONLY after a CONFIRMED
    // durable completion, and NEVER after the route aborted (an abandoned promise can never mutate
    // evidence later). Every durable write is bounded in-flight through the ONE route deadline.
    const persistSnapshotBase = makePersistSnapshot(orgFingerprint, dl);
    const trackedReplaceHistory = async (args) => {
      const outcome = await dl.bound("history-replace", (signal) => replaceHistory({ ...args, signal }), { write: true });
      if (liveEvidence && outcome && outcome.write === "ok" && !dl.aborted()) {
        const keep = liveEvidence.historyRows.filter((r) => !(r.account_id === args.accountId && r.sale_date >= args.coveredFrom && r.sale_date <= args.coveredTo));
        // Fold the NON-cancelled daily rollup (args.rollupRows) -- exactly what the RPC wrote to
        // source_oli_daily_history -- into the in-memory evidence, so the derive stage reflects this fetch with
        // cancelled orders already excluded. (Falls back to args.rows for the legacy non-dimensional shape.)
        const foldRows = Array.isArray(args.rollupRows) ? args.rollupRows : (args.rows || []);
        for (const r of foldRows) {
          keep.push({ account_id: r.accountId, sale_date: r.saleDate, sku: r.sku, child_asin: r.childAsin, currency: r.currency, sales_amount: r.salesAmount, units: r.units, source_request_hash: r.sourceRequestHash ?? r.source_request_hash ?? null });
        }
        liveEvidence.historyRows = keep;
        (liveEvidence.oliCoverageByAccountId[args.accountId] = liveEvidence.oliCoverageByAccountId[args.accountId] || []).push({ from: args.coveredFrom, to: args.coveredTo });
      }
      return outcome;
    };
    const trackedPersistSnapshot = async (args) => {
      const res = await dl.bound("snapshot-persist", (signal) => persistSnapshotBase({ ...args, signal }), { write: true });
      if (liveEvidence && !dl.aborted()) {
        // Round-6 fix 2: fold the AUTHORITATIVE evidence the CAS acknowledged -- never a losing candidate.
        if (args.sourceKey === CATALOG_SOURCE_KEY) {
          liveEvidence.catalogSnapshot = res.authoritativeSnapshot;
          liveEvidence.catalogRows = [...res.authoritativeRows];
        } else if (args.sourceKey === FBA_INVENTORY_SOURCE_KEY) {
          liveEvidence.fbaSnapshotsByAccount[args.scopeKey] = res.authoritativeSnapshot;
          liveEvidence.fbaRowsByAccount[args.scopeKey] = [...res.authoritativeRows];
        }
      }
      return res;
    };
    const boundedUpdateRunStatus = updateRunStatus == null ? null
      : (entry) => dl.bound("run-status-write", (signal) => updateRunStatus(entry, { signal }), { write: true });

    let rollup;
    try {
      rollup = await runBucketSourceSync({
        apiKey: primary.apiKey, bucket, accounts,
        existingMembership,
        coverageByAccountId,
        catalogSnapshot: catalogSnapForSync,
        fbaSnapshotsByAccount: fbaSnapshotsForSync,
        pausedSources,
        asOf: asOfStr, today: todayStr,
        store, dataDoe,
        replaceHistoryWindow: trackedReplaceHistory, persistSnapshot: trackedPersistSnapshot, updateRunStatus: boundedUpdateRunStatus,
        recordCompleteness: recordOliCompleteness,
        cycleDate: cycleDate || todayStr, trigger: "manual",
        clock, wait: null, cooldownMs: 0, // ONE bounded manual pass; the scheduler owns cadence/cooldown
        deadlineMs: dl.deadlineMs, reserveMs: dl.reserveMs,
        reuseOnly,
        catalogCarrierSeller,
        forceCatalogRefresh: priority,
        forceFreshOli: forceFreshOli === true,
      });
    } catch (e) { return catchDeadline(e); }
    rollup.excludedAccounts = excluded;
    // Round-6 fix 1: EVERY rollup shape reports honestly that this runtime never finalized anything; the
    // cycle-status READ at the end refines cycleStatus for completed runs only.
    rollup.finalized = false;
    rollup.cycleStatus = null;

    // FINDING 4: after a COMPLETE bucket sync (not stopped/resumable), derive/validate/save the Daily +
    // Brand View + compact brand-inventory durable SHADOW snapshots. A read failure or non-ready readiness
    // is a TYPED skip -- nothing is fabricated, nothing live is touched.
    rollup.derived = { skipped: null, daily: null, brandView: null, brandInventory: null, lineage: [] };
    if (rollup.stopped || rollup.continuationRequired || !rollup.globalDrained) {
      rollup.derived.skipped = rollup.stopped ? "bucket-stopped" : (rollup.continuationRequired ? "continuation-required" : "not-drained");
      return rollup;
    }
    // FINDING 2: the derive half shares the SAME deadline (evidence, hydration, history, derivation, saves);
    // expiry is a typed resumable skip -- a fresh invocation finds the sources complete and derives directly.
    // Round-7 finding 1: PRESERVE the deadline error's commitUnknown flag onto the rollup -- an in-flight
    // lineage/shadow WRITE that timed out may already have committed, so the resumable rollup must report it
    // (never claim the write did not happen).
    const deriveResumable = (cause = null) => {
      rollup.derived.skipped = "deadline";
      rollup.deadlineReached = true;
      rollup.continuationRequired = true;
      rollup.commitUnknown = !!rollup.commitUnknown || !!(cause && cause.commitUnknown);
      return rollup;
    };
    // The date the scheduler ATTEMPTED to reach (requested asOf). The durable evidence load below spans the full
    // window ending here; the effective PUBLISH date is resolved from the coverage evidence AFTER the load and may
    // clamp back to the latest date every account can prove (a recent unsettled tail is never fabricated forward).
    const refreshAsOf = asOfStr;
    let dailyWindow = { from: monthBackStr(refreshAsOf, 5), to: refreshAsOf };
    let brandViewWindow = oliBackfillWindow(refreshAsOf);
    let evidence;
    let historyRows = null;
    const adMetricsByAccountId = {};
    if (liveEvidence) {
      // Round-5 blocker 3: the ONE memoized preflight result IS the evidence -- already hydrated and
      // staleness-validated, refreshed in-memory with the sync's own persisted products above. NO
      // discovery, coverage, snapshot, hydration, Ads or history read is repeated here.
      evidence = liveEvidence;
      historyRows = liveEvidence.historyRows;
      Object.assign(adMetricsByAccountId, preflight.adMetricsByAccountId || {});
    } else {
      try {
        evidence = await gatherEvidence({ orgFingerprint, accounts, today: todayStr, ensureTime, bound: dl.bound });
      } catch (e) { if (dl.isDeadlineError(e)) return deriveResumable(e); throw e; }
    }
    if (!evidence.catalogRows) {
      rollup.derived.skipped = evidence.catalogSnapshot ? "catalog-hydration-failed" : "catalog-snapshot-missing";
      return rollup;
    }
    if (!liveEvidence) {
      try {
        historyRows = await dl.bound("history-load", (signal) => loadHistoryRows({
          organizationFingerprint: orgFingerprint, connectionId: "primary",
          accountIds: accounts.map((a) => a.accountId),
          from: brandViewWindow.from, to: brandViewWindow.to,
          signal,
        }));
        // FINDING 3 + round-4 finding 1: ACTUAL campaign Ads metric rows WITH their typed read state. A
        // failed/limited/malformed read is NEVER flattened into [] + "ok" -- the typed metricsRead travels
        // into the ads-coverage contract so Daily can never report a false zero-Ads result.
        for (const a of accounts) {
          try {
            const rows = await dl.bound("ads-metrics-load", (signal) => readAdMetrics(a.accountId, dailyWindow.from, dailyWindow.to, { signal }));
            adMetricsByAccountId[a.accountId] = Array.isArray(rows)
              ? { rows, metricsRead: "ok" }
              : { rows: [], metricsRead: "read-failed" };
          } catch (e) {
            if (dl.isDeadlineError(e)) throw e;
            adMetricsByAccountId[a.accountId] = { rows: [], metricsRead: e && e.code === "ADS_ROW_LIMIT_EXCEEDED" ? "limit-exceeded" : "read-failed" };
          }
        }
      } catch (e) { if (dl.isDeadlineError(e)) return deriveResumable(e); historyRows = null; }
      if (!Array.isArray(historyRows)) {
        rollup.derived.skipped = "history-read-failed";
        return rollup;
      }
    }
    // REQUESTED vs EFFECTIVE as-of. The evidence is now loaded, so resolve the latest date EVERY account in the
    // publication scope can prove with gapless durable OLI coverage. A recent unsettled/NULL-price tail on some
    // accounts clamps the publish date back to the latest COMMON proven completed date (never zero-padded, never
    // pushed past refreshAsOf); an interior historical hole leaves the effective date null so the derive fails
    // closed (windowsProve rejects the blocked account below). The cycle DATE stays clock-today; only the
    // derive/save WINDOWS clamp, so Daily + Brand View publish the same honest coversAsOf.
    const effResolution = resolveEffectivePublishAsOf({
      coverageByAccountId: evidence.oliCoverageByAccountId,
      accountIds: accounts.map((a) => a.accountId),
      from: brandViewWindow.from, refreshAsOf,
    });
    const effectivePublishAsOf = effResolution.effectiveAsOf || refreshAsOf;
    rollup.derived.refreshAsOf = refreshAsOf;
    rollup.derived.effectivePublishAsOf = effectivePublishAsOf;
    rollup.derived.asOfClamped = effectivePublishAsOf !== refreshAsOf;
    rollup.derived.asOfBlockers = effResolution.blockers;
    dailyWindow = { from: monthBackStr(effectivePublishAsOf, 5), to: effectivePublishAsOf };
    brandViewWindow = { from: brandViewWindow.from, to: effectivePublishAsOf };

    // ADDITIVE, ZERO-DataDoe: recompute the INTERNAL missing/zero-price sales estimates from the freshly-persisted
    // durable truth (operational units + dimensional references) for the RECENT part of the derive window, then
    // enrich the history rows so Daily Reporting + Brand View publish the estimate-included Total Sales through the
    // one canonical calculation. Older estimates in the window are already materialized (one-time backfill + prior
    // recomputes). FULLY NON-FATAL + never uses the route deadline: any failure leaves the priced Total Sales, the
    // unit counts, and LKG completely intact -- the estimate layer can never break, slow past budget, or regress a
    // derive. Fail-soft pre-migration (the estimate reader/writer degrade to a no-op). Gated by enableSalesEstimates.
    if (enableSalesEstimates) try {
      const estTo = effectivePublishAsOf;
      const estRecomputeFrom = (() => { const s = addDaysStr(estTo, -45); return s > brandViewWindow.from ? s : brandViewWindow.from; })();
      // ONE shared authority (same resolver as the backfill; NO last-write-wins): an account is estimated ONLY under
      // its UNIQUELY proven canonical marketplace. Missing OR ambiguous authority -> "" so the recompute still runs
      // but resolves NOTHING and writes [] -> any stale estimate window is CLEARED and the grains stay unresolved
      // (fail closed; never guessed, never one-of-an-ambiguous-set). Additive + non-fatal: the priced Total Sales,
      // the unit counts, and LKG are never touched by this step.
      const marketplaceResolution = resolveUniqueMarketplaceByAccount(accounts);
      rollup.derived.marketplaceResolution = summarizeMarketplaceResolution(marketplaceResolution);
      for (const a of accounts) {
        const acctMkt = authoritativeMarketplace(marketplaceResolution, a.accountId);
        if (!acctMkt) {
          const st = marketplaceResolution.get(String(a.accountId).trim());
          const code = st && st.status === "ambiguous" ? OLI_ESTIMATE_MARKETPLACE_AMBIGUOUS : OLI_ESTIMATE_MARKETPLACE_MISSING;
          try { console.warn(`${code} account=${String(a.accountId).slice(0, 8)} -> estimates cleared + unresolved (fail closed)`); } catch { /* telemetry only */ }
        }
        await recomputeSalesEstimates({
          organizationFingerprint: orgFingerprint, connectionId: "primary", accountId: a.accountId,
          accountMarketplace: acctMkt, // UNIQUELY proven canonical marketplace only ("" fails closed)
          from: estRecomputeFrom, to: estTo,
          readOperationalUnits: readOperationalUnitsForEstimate,
          readDimensionalRows: readDimensionalRowsForEstimate,
          readSkuAsinResolution: readSkuAsinResolutionForEstimate,
          writeEstimates: writeSalesEstimates,
        }).catch(() => null);
      }
      // CANONICAL ORDERED MERGE: priced rollup + operational units (ordered units = priced + explicit-zero +
      // pending) + estimates (actual-plus-estimated sales), per account, so Daily Reporting + Brand View publish
      // BOTH ordered units and the enriched Total Sales through the ONE shared seam. A blank ASIN on a pending/zero
      // grain is resolved to its unique ASIN (same resolver as the estimator) so units co-locate with the estimate.
      // Additive + non-fatal: on ANY failure historyRows stays the priced rows (units + sales + LKG never regressed).
      const marketplaceByAccount = new Map(accounts.map((a) => [String(a.accountId), authoritativeMarketplace(marketplaceResolution, a.accountId)]));
      if (Array.isArray(historyRows)) {
        historyRows = await enrichOrderedHistory({
          organizationFingerprint: orgFingerprint, connectionId: "primary",
          accountIds: accounts.map((a) => a.accountId), from: brandViewWindow.from, to: estTo,
          historyRows, marketplaceByAccount,
          readOperationalUnits: readOperationalUnitsForEstimate,
          readEstimates: readSalesEstimates,
          readSkuAsinResolution: readSkuAsinResolutionForEstimate,
        });
      }
    } catch { /* additive: never regress the priced Total Sales or LKG */ }

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
        adsCoverageStateByAccountId: evidence.asinCoverageStateByAccountId,
        dailyWindow, brandViewWindow,
      });
    } catch (e) { if (dl.isDeadlineError(e)) return deriveResumable(e); throw e; }
    const saver = makeShadowSaver();
    // Round-10 blocker 1: the caller/route wall clock is NEVER the freshness authority for durable shadow
    // evidence. `nowIso` survives ONLY for the degenerate no-cycle / no-lineage fallback below (a plain,
    // non-CAS save with no freshness ordering); the durable path uses `durableRefreshedAt` (the owning cycle's
    // database-created timestamp), assigned once from store.getCycle before the save loop.
    const nowIso = () => new Date(clock()).toISOString();
    let durableRefreshedAt = null;
    let dailySaved = 0;
    let brandViewSaved = 0;
    // Round-5 blocker 1: GENUINE publishable lineage, CLAIM-BEFORE-SAVE. For each report job:
    //   1. upsert the sync_report_jobs row with depends_on bound to the EXACT authoritative source request
    //      hashes -- THIS cycle's SUCCEEDED rows for the source families the report consumed;
    //   2. CLAIM the derive attempt and require claim === true STRICTLY -- only the claim winner may save;
    //   3. save the shadow snapshot UNDER the held claim;
    //   4. record validated success with the EXACT saver-computed snapshot_params_hash.
    // A lost/false/malformed claim is a TYPED skip: the save does not happen and success is NEVER recorded
    // (idempotent resume: a fresh invocation over a completed job loses the claim and changes nothing).
    //
    // Round-6 fix 5: depends_on is ACCOUNT-EXACT, built from the AUTHORITATIVE durable ownership
    // (sync_source_job_owners of THIS cycle): an account's report depends ONLY on source hashes that
    // account genuinely owns -- its own batch's OLI export (one owner row per member), its OWN FBA export
    // -- plus the shared ORGANIZATION-scope evidence (canonical Product Catalog, owner "__organization").
    // One account can NEVER depend on another batch's OLI/FBA hash; bucket-wide family membership is not
    // ownership.
    const sourceJobRows = rollup.cycleId ? await dl.bound("source-jobs-read", () => store.listSourceJobs(rollup.cycleId)) : [];
    if (rollup.cycleId && typeof store.listCycleOwners !== "function") {
      const err = new Error("LINEAGE_OWNERSHIP_UNAVAILABLE: the store cannot list this cycle's owner memberships; refusing to record report lineage with unproven depends_on (fail closed).");
      err.code = "LINEAGE_OWNERSHIP_UNAVAILABLE";
      err.status = 503;
      throw err;
    }
    const ownerRows = rollup.cycleId ? await dl.bound("cycle-owners-read", (signal) => store.listCycleOwners(rollup.cycleId, { signal })) : [];
    const orgOwnedHashes = new Set();
    const accountOwnedHashes = new Map(); // accountId -> Set(request_hash)
    for (const o of ownerRows || []) {
      if ((o.owner_status ?? o.ownerStatus) === "stale") continue;
      const aid = String(o.account_id ?? o.accountId ?? "");
      const h = o.request_hash ?? o.requestHash;
      if (!h) continue;
      if (aid === ORGANIZATION_SCOPE_KEY || aid === "") { orgOwnedHashes.add(h); continue; }
      if (!accountOwnedHashes.has(aid)) accountOwnedHashes.set(aid, new Set());
      accountOwnedHashes.get(aid).add(h);
    }
    const jobByHash = new Map(sourceJobRows.map((r) => [r.request_hash ?? r.requestHash, r]));
    const succeededHashesFor = (accountId, families) => {
      const owned = accountOwnedHashes.get(String(accountId)) || new Set();
      const out = [];
      for (const [h, r] of jobByHash) {
        if ((r.fetch_status ?? r.fetchStatus) !== "succeeded") continue;
        if (!families.includes(r.source_key ?? r.sourceKey)) continue;
        if (owned.has(h) || orgOwnedHashes.has(h)) out.push(h);
      }
      return out.sort();
    };
    const LINEAGE_DEPENDS_ON = {
      "daily-reporting": [OLI_SOURCE_KEY, CATALOG_SOURCE_KEY],
      "brand-sales": [OLI_SOURCE_KEY, CATALOG_SOURCE_KEY],
      [BRAND_INVENTORY_SNAPSHOT_KEY]: [OLI_SOURCE_KEY, CATALOG_SOURCE_KEY, FBA_INVENTORY_SOURCE_KEY],
    };
    // Durable-evidence lineage (provenance binding): the DURABLE OLI history each account's rows came from
    // carries their originating source_request_hash. When THIS cycle planned no new OLI export for an account
    // (its OLI is already fully proven -- the zero-OLI-create covered-account derivation), the report's OLI
    // depends_on binds to that PERSISTED provenance instead of the (empty) current cycle. It is account-EXACT
    // (keyed by the account's own rows; a batch export legitimately serves its <=5 owner accounts) and fails
    // closed: a ready account with NO durable OLI provenance, or a row missing its source_request_hash, is a
    // typed skip -- never a snapshot with unproven lineage. When this cycle DID fetch OLI, the behaviour is
    // byte-identical (the cycle's own succeeded OLI hash is used, exactly as before).
    const oliProvenanceByAccount = new Map(); // accountId -> Set(source_request_hash | null-for-malformed)
    for (const r of historyRows || []) {
      const aid = String(r.account_id ?? r.accountId ?? "");
      if (!aid) continue;
      if (!oliProvenanceByAccount.has(aid)) oliProvenanceByAccount.set(aid, new Set());
      const h = r.source_request_hash ?? r.sourceRequestHash;
      oliProvenanceByAccount.get(aid).add(typeof h === "string" && h.trim() !== "" ? h : null);
    }
    // Returns { deps: sorted hashes, oliMissing }. Non-OLI families always come from THIS cycle's succeeded
    // jobs (catalog/FBA are fetched/refreshed per cycle). OLI comes from this cycle when present, else from the
    // durable provenance (fail-closed when a ready OLI-dependent account has no/malformed durable provenance).
    const dependsOnFor = (accountId, reportKey) => {
      const families = LINEAGE_DEPENDS_ON[reportKey] || [];
      if (!families.includes(OLI_SOURCE_KEY)) return { deps: succeededHashesFor(accountId, families), oliMissing: false };
      const nonOli = families.filter((f) => f !== OLI_SOURCE_KEY);
      const otherHashes = succeededHashesFor(accountId, nonOli);
      const oliCycleHashes = succeededHashesFor(accountId, [OLI_SOURCE_KEY]);
      let oliDeps;
      let oliMissing = false;
      if (oliCycleHashes.length > 0) {
        oliDeps = oliCycleHashes; // OLI fetched THIS cycle -> unchanged behaviour
      } else {
        oliDeps = [...(oliProvenanceByAccount.get(String(accountId)) || [])]; // persisted earlier -> durable provenance
        oliMissing = oliDeps.length === 0 || oliDeps.some((h) => !h); // no rows / a row lacked its provenance
      }
      const deps = [...new Set([...otherHashes, ...oliDeps.filter(Boolean)])].sort();
      return { deps, oliMissing };
    };
    // Round-7 finding 1: CLAIM-LEASE -> save-if-absent -> RECONCILE. The lease makes a commitUnknown
    // mid-derive recoverable: a fresh invocation observes 'already-complete' (nothing to do), 'held' (a live
    // worker owns it -- never stolen), 'terminal' (failed/skipped for this cycle), 'claimed' (first-time) or
    // 'reclaimed' (a stale/abandoned lease safely recovered). On claimed/reclaimed the payload is re-derived
    // from DURABLE evidence (ZERO DataDoe), the EXACT durable snapshot is ADOPTED when it already exists (a
    // shadow-save commit-unknown left it), else saved once, then reconcile (guarded by the held lease token
    // AND the exact durable snapshot identity) flips the job to success. Nothing here fabricates success.
    const saveShadow = (snap, params, signal, refreshedAt) => saver({
      reportKey: snap.reportKey, accountId: snap.accountId, params, payload: snap.payload, sourceRefreshedAt: refreshedAt,
    }, { signal });
    const saveWithLineage = async (snap, params) => {
      const paramsHash = paramsHashFor(params.reportVersion, params);
      if (!reportLineage || !rollup.cycleId) {
        // Degenerate non-durable path (no lineage / no cycle): a plain save with no freshness ordering. There
        // is no owning-cycle evidence timestamp, so this path (and ONLY this path) uses the wall clock.
        const saved = await dl.bound("shadow-save", (signal) => saveShadow(snap, params, signal, nowIso()), { write: true });
        return { complete: true, newlySaved: true, saved, lineage: "unavailable" };
      }
      const note = (outcome, detail) => rollup.derived.lineage.push({ reportKey: snap.productionReportKey, accountId: snap.accountId, outcome, ...(detail ? { detail } : {}) });
      // Provenance binding + fail-closed: a ready OLI-dependent account whose durable OLI provenance is
      // missing/malformed is NEVER saved/published with unproven lineage.
      const dep = dependsOnFor(snap.accountId, snap.productionReportKey);
      if (dep.oliMissing) {
        note("durable-oli-provenance-missing");
        return { complete: false, newlySaved: false, saved: null, lineage: "durable-oli-provenance-missing" };
      }
      await dl.bound("report-lineage-upsert", (signal) => reportLineage.upsertReportJob({
        cycleId: rollup.cycleId, reportKey: snap.productionReportKey, reportVersion: snap.version,
        accountId: snap.accountId, connectionId: "primary", bucket,
        dependsOn: dep.deps,
      }, { signal }), { write: true });
      // Round-8 finding 1: the claim uses DATABASE-authoritative time -- NO caller clock is passed.
      const lease = await dl.bound("report-lineage-claim", (signal) => reportLineage.claimLease(
        rollup.cycleId, snap.productionReportKey, snap.accountId, { leaseSeconds: reportDeriveLeaseSeconds, signal },
      ), { write: true });
      const disp = lease && lease.disposition;
      // Round-9 finding 1: an 'already-complete' observation is a valid completion ONLY when its bound
      // snapshot hash IS this derivation's current hash; a hash-less or DIFFERENT-hash completion is an
      // integrity failure for THIS derivation, never a success.
      if (disp === "already-complete") {
        if (lease.snapshotParamsHash !== paramsHash) {
          note("already-complete-hash-mismatch", lease.snapshotParamsHash || "missing");
          return { complete: false, newlySaved: false, saved: null, lineage: "already-complete-hash-mismatch" };
        }
        note("already-complete");
        return { complete: true, newlySaved: false, saved: null, lineage: "already-complete" };
      }
      // Round-9 finding 2: a TOTAL, accurately-resumable classification. held is resumable; terminal,
      // invalid-state, not-found, invalid-lease and any malformed claim are NON-resumable typed failures.
      if (disp === "held") { note("claim-held"); return { complete: false, newlySaved: false, saved: null, lineage: "claim-held" }; }
      if (disp === "terminal") { note("terminal", lease.deriveStatus); return { complete: false, newlySaved: false, saved: null, lineage: "terminal" }; }
      if ((disp !== "claimed" && disp !== "reclaimed") || !lease.leaseToken) {
        note("claim-invalid", disp || "malformed");
        return { complete: false, newlySaved: false, saved: null, lineage: "claim-invalid" };
      }
      const leaseToken = lease.leaseToken;
      const recovered = disp === "reclaimed";
      const entry = REPORT_DERIVATIONS[snap.productionReportKey] || null;
      // Round-8 finding 2 + round-9 finding 3: NEVER adopt a durable snapshot merely because its identity row
      // exists. Validate the EXACT identity (report_key / account_id / params_hash), params provenance, exact
      // derivation version + account, hydrate the payload with STORAGE-FIRST precedence (a nonblank
      // payload_storage_path is authoritative and is always hydrated + validated, even if an inline payload is
      // also present; inline is used ONLY when the path is blank; dangling/unavailable fail closed), and the
      // exact report payload contract. Returns { ok, payload } (the authoritative payload) or a typed reason.
      const shadowKey = snap.reportKey;
      const validateDurableSnapshot = async (row) => {
        const p = row && row.params && typeof row.params === "object" && !Array.isArray(row.params) ? row.params : null;
        if (!p || typeof p.reportVersion !== "string") return { ok: false, reason: "params-missing" };
        // Exact returned identity (finding 3): report_key / account_id / params_hash must be THIS identity.
        if (String(row.report_key ?? row.reportKey) !== shadowKey) return { ok: false, reason: "identity-report-key" };
        if (String(row.account_id ?? row.accountId) !== String(snap.accountId)) return { ok: false, reason: "identity-account" };
        if (String(row.params_hash ?? row.paramsHash) !== paramsHash) return { ok: false, reason: "identity-hash" };
        if (!entry || p.reportVersion !== entry.snapshotVersion) return { ok: false, reason: "wrong-version" };
        if (String(p.accountId) !== String(snap.accountId)) return { ok: false, reason: "wrong-account" };
        if (paramsHashFor(p.reportVersion, p) !== paramsHash) return { ok: false, reason: "params-provenance" };
        // STORAGE-FIRST payload precedence (finding 3): the pointer is authoritative when nonblank.
        const path = String(row.payload_storage_path ?? row.payloadStoragePath ?? "").trim();
        let payload;
        if (path) {
          try { payload = await dl.bound("shadow-hydrate", (signal) => loadShadowStoragePayload(path, { signal })); }
          catch (e) { if (dl.isDeadlineError(e)) throw e; payload = null; }
          if (payload == null) return { ok: false, reason: "payload-dangling" };
        } else {
          payload = row.payload;
          if (payload == null) return { ok: false, reason: "payload-unavailable" };
        }
        if (!(entry && typeof entry.validatePayload === "function" && entry.validatePayload(payload) === true)) return { ok: false, reason: "payload-invalid" };
        return { ok: true, payload };
      };
      const existing = await dl.bound("shadow-read", (signal) => readShadowSnapshot({ reportKey: shadowKey, accountId: snap.accountId, paramsHash }, { signal }));
      let newlySaved = false;
      // Round-11 blocker: EVERY durable-lineage shadow write -- the initially-absent branch INCLUDED -- goes
      // through the ATOMIC freshness CAS (cas_report_snapshot_if_newer). A merge-duplicates upsert on the
      // absent branch would let two cycles both read the row as absent and then let an older cycle's DELAYED
      // write clobber a newer cycle's row without consulting freshness. The CAS owns insert-if-absent AND
      // freshness ordering under a row lock, so concurrent writers converge on the newer evidence and a losing
      // (older) candidate is a typed-resumable 'newer-live', never a merge-upsert and never a false success.
      // The merge-upsert saver (`saveShadow`) is reachable ONLY on the degenerate no-lineage path above.
      // Returns a typed disposition: 'saved' (inserted/replaced -> reconcile), 'adopted' (already-current, the
      // wrapper PROVED storage-first content identity -> reconcile without re-writing), 'newer-live' (a newer
      // durable exists -> resumable, no reconcile for this losing candidate), or 'conflict' (fail closed).
      const persistViaCas = async () => {
        const bytes = assertSnapshotWithinLimit(snap.payload);
        const cas = await dl.bound("shadow-cas-save", (signal) => saveShadowIfNewer({
          reportKey: shadowKey, accountId: snap.accountId, paramsHash, params, payload: snap.payload,
          payloadBytes: bytes, sourceRefreshedAt: durableRefreshedAt,
        }, { signal }), { write: true });
        const outcome = cas && cas.outcome;
        if (outcome === "inserted" || outcome === "replaced") return { disp: "saved" };
        if (outcome === "already-current") return { disp: "adopted" };
        if (outcome === "newer-live") return { disp: "newer-live" };
        return { disp: "conflict", conflict: outcome || "cas-conflict" };
      };
      if (existing) {
        const verdict = await validateDurableSnapshot(existing);
        if (!verdict.ok) {
          // Integrity/identity failure -> typed NON-resumable conflict (never reconcile, never validated).
          note("snapshot-conflict", verdict.reason);
          return { complete: false, newlySaved: false, saved: null, lineage: "snapshot-conflict", conflict: verdict.reason };
        }
        if (canonicalJson(verdict.payload) !== canonicalJson(snap.payload)) {
          // Round-9 finding 4: a valid DIFFERENT durable payload for the same identity is not a permanent
          // block -- route through the reviewed atomic freshness CAS (a STRICTLY-NEWER candidate replaces older
          // shadow evidence; an OLDER 'newer-live' candidate is typed-resumable; an EQUAL-but-conflicting
          // candidate preserves LKG and fails closed non-resumable).
          const r = await persistViaCas();
          if (r.disp === "saved") { newlySaved = true; }
          else if (r.disp === "adopted") { /* a concurrent identical write landed between our read and CAS -> adopt */ }
          else if (r.disp === "newer-live") { note("snapshot-newer", "newer-live"); return { complete: false, newlySaved: false, saved: null, lineage: "snapshot-newer" }; }
          else { note("snapshot-conflict", r.conflict); return { complete: false, newlySaved: false, saved: null, lineage: "snapshot-conflict", conflict: r.conflict }; }
        }
        // else: the validated durable content already EQUALS our candidate -> adopt (no write) -> reconcile.
      } else {
        // Round-11: the initially-absent branch ALSO goes through the CAS (insert-if-absent), never a
        // merge-upsert. If a concurrent (newer) cycle inserted between our read and this CAS, our older
        // candidate loses with 'newer-live' and is never reconciled -- the newer row is preserved.
        const r = await persistViaCas();
        if (r.disp === "saved") { newlySaved = true; }
        else if (r.disp === "adopted") { /* a concurrent identical write already landed -> adopt */ }
        else if (r.disp === "newer-live") { note("snapshot-newer", "newer-live"); return { complete: false, newlySaved: false, saved: null, lineage: "snapshot-newer" }; }
        else { note("snapshot-conflict", r.conflict); return { complete: false, newlySaved: false, saved: null, lineage: "snapshot-conflict", conflict: r.conflict }; }
      }
      const rec = await dl.bound("report-lineage-reconcile", (signal) => reportLineage.reconcileSuccess({
        cycleId: rollup.cycleId, reportKey: snap.productionReportKey, accountId: snap.accountId,
        snapshotParamsHash: paramsHash, leaseToken, latestDataDate: snap.latestDataDate ?? null,
      }, { signal }), { write: true });
      const rdisp = rec && rec.disposition;
      if (rdisp === "reconciled" || rdisp === "already-complete") {
        note(recovered ? "recovered" : "recorded");
        return { complete: true, newlySaved, saved: newlySaved ? { paramsHash } : null, lineage: recovered ? "recovered" : "recorded" };
      }
      // Round-9 finding 2: reconcile failures are classified by their ACTUAL state, never blanket-transient.
      if (rdisp === "lease-lost") { note("reconcile-lease-lost"); return { complete: false, newlySaved, saved: null, lineage: "reconcile-lease-lost" }; }
      if (rdisp === "snapshot-absent") {
        // Classify: a snapshot-absent AFTER a clean (known-committed) save this round is an INTEGRITY failure
        // (the save did not land) -> non-resumable; on the ADOPT path (no save this round) the previously
        // validated durable snapshot vanished concurrently -> resumable (re-derive + re-save next invocation).
        if (newlySaved) { note("snapshot-integrity", "absent-after-save"); return { complete: false, newlySaved, saved: null, lineage: "snapshot-integrity" }; }
        note("reconcile-snapshot-absent", "vanished"); return { complete: false, newlySaved, saved: null, lineage: "reconcile-snapshot-absent" };
      }
      // not-found / invalid-state / terminal / malformed reconcile ack -> NON-resumable typed failure.
      note("reconcile-invalid", rdisp || "malformed");
      return { complete: false, newlySaved, saved: null, lineage: "reconcile-invalid" };
    };
    try {
      // Round-10 blocker 1: resolve the DB-authoritative durable freshness ONCE, before any shadow save. It is
      // the OWNING CYCLE's database-created timestamp -- stable across retries, ordering an older cycle strictly
      // below a newer one regardless of which worker finishes later. A durable-lineage run whose cycle has no
      // readable created_at fails closed (never a fabricated / wall-clock freshness on durable evidence).
      if (rollup.cycleId) {
        if (reportLineage && typeof store.getCycle !== "function") {
          const err = new Error("LINEAGE_FRESHNESS_UNAVAILABLE: the store cannot read this cycle's database-created timestamp; refusing to save durable shadow evidence with a fabricated freshness (fail closed).");
          err.code = "LINEAGE_FRESHNESS_UNAVAILABLE"; err.status = 503;
          throw err;
        }
        if (typeof store.getCycle === "function") {
          const cycleRow = await dl.bound("cycle-created-read", (signal) => store.getCycle(rollup.cycleId, { signal }));
          const created = cycleRow && (cycleRow.created_at ?? cycleRow.createdAt);
          durableRefreshedAt = created != null && String(created).trim() !== "" ? String(created) : null;
        }
        if (reportLineage && durableRefreshedAt == null) {
          const err = new Error("LINEAGE_FRESHNESS_UNAVAILABLE: the owning cycle has no database-created timestamp; refusing to save durable shadow evidence with a fabricated freshness (fail closed).");
          err.code = "LINEAGE_FRESHNESS_UNAVAILABLE"; err.status = 503;
          throw err;
        }
      }
      for (const snap of derived.daily.snapshots) {
        await ensureTime("snapshot-save");
        const r = await saveWithLineage(snap, { reportVersion: snap.version, accountId: snap.accountId, from: dailyWindow.from, to: dailyWindow.to, brand: "ALL" });
        if (r.complete) dailySaved += 1;
      }
      for (const snap of derived.brandView.snapshots) {
        await ensureTime("snapshot-save");
        const r = await saveWithLineage(snap, { reportVersion: snap.version, accountId: snap.accountId, from: brandViewWindow.from, to: brandViewWindow.to });
        if (r.complete) brandViewSaved += 1;
      }
    } catch (e) { if (dl.isDeadlineError(e)) return deriveResumable(e); throw e; }

    // Round-5 blocker 2: wire the DURABLE FBA evidence into Brand View's REAL production read path -- build
    // the validated compact brand-inventory snapshot via the EXISTING buildBrandInventorySnapshot contract
    // (asinBrand ONLY from the just-derived brand-sales payload; fetchInventoryRows returns the HYDRATED
    // durable FBA rows -- ZERO DataDoe) and save it under the EXISTING shadow key/version, so
    // buildAccountBrandSlice consumes it through its normal compact-snapshot gate with no new mechanism.
    // A contract refusal (missing brand map, truncation, invalid row) preserves the previous compact
    // snapshot and is recorded TYPED per account.
    const brandInventory = { saved: 0, skipped: [] };
    const invWindow = { from: addDaysStr(asOfStr, -BRAND_INVENTORY_LOOKBACK_DAYS), to: asOfStr };
    const brandSalesByAccount = new Map(derived.brandView.snapshots.map((s) => [s.accountId, s]));
    try {
      for (const account of accounts) {
        let invRows = evidence.fbaRowsByAccount ? evidence.fbaRowsByAccount[account.accountId] : undefined;
        const sales = brandSalesByAccount.get(account.accountId);
        if (!Array.isArray(invRows)) {
          // PRIORITY DASHBOARDS PATH: no durable FBA snapshot for this account -> represent inventory as
          // UNAVAILABLE (empty rows => buildBrandInventoryPayload yields inventoryAvailable:false) rather than
          // skipping, so Brand View publishes for every covered account with zero FBA export. The normal
          // (non-priority) path still preserves the previous compact snapshot and records the typed skip.
          if (priority) { invRows = []; }
          else { brandInventory.skipped.push({ accountId: account.accountId, reason: "no-validated-fba-snapshot" }); continue; }
        }
        if (!sales) { brandInventory.skipped.push({ accountId: account.accountId, reason: "no-brand-sales-snapshot" }); continue; }
        await ensureTime("brand-inventory-derive");
        let built;
        try {
          built = await buildBrandInventorySnapshot({
            accountId: account.accountId, accountCountry: account.country,
            from: invWindow.from, to: invWindow.to, rowLimit: BRAND_INVENTORY_ROW_LIMIT,
            getSnapshot: async ({ reportKey }) => (reportKey === "brand-sales" ? { payload: sales.payload } : null),
            fetchInventoryRows: async () => invRows,
          });
        } catch (e) {
          if (dl.isDeadlineError(e)) throw e;
          brandInventory.skipped.push({ accountId: account.accountId, reason: "contract-refused" });
          continue;
        }
        const snap = {
          reportKey: shadowSnapshotKey(BRAND_INVENTORY_SNAPSHOT_KEY), productionReportKey: BRAND_INVENTORY_SNAPSHOT_KEY,
          accountId: account.accountId, version: BRAND_INVENTORY_REPORT_VERSION,
          payload: built.payload, latestDataDate: built.payload.inventoryDate || null,
        };
        const r = await saveWithLineage(snap, { reportVersion: snap.version, accountId: snap.accountId, to: invWindow.to });
        if (r.complete) brandInventory.saved += 1;
      }
    } catch (e) { if (dl.isDeadlineError(e)) return deriveResumable(e); throw e; }
    // Round-8 finding 3 + round-9 finding 2: an HONEST, ACCURATELY-RESUMABLE rollup. derived.skipped stays
    // null ONLY when EVERY report genuinely completed (recorded / recovered / already-complete). Otherwise
    // skipped is a typed non-null and the incomplete items are enumerated. ONLY genuinely-recoverable
    // outcomes set continuationRequired -- a live worker's hold (claim-held), a concurrent takeover
    // (reconcile-lease-lost), a concurrently-vanished durable snapshot (reconcile-snapshot-absent), and a
    // newer-durable refresh (snapshot-newer). A terminal report, a claim/reconcile invalid-state, a hash
    // mismatch, a snapshot integrity/conflict -- all TERMINAL/CONFIGURATION failures -- are NON-resumable
    // (continuationRequired is NOT set), so they can never create an endless continuation loop. The shared
    // cycle honestly stays open (finalize returns open-work) until a genuine resolution.
    const COMPLETE_OUTCOMES = new Set(["recorded", "recovered", "already-complete"]);
    const RESUMABLE_OUTCOMES = new Set(["claim-held", "reconcile-lease-lost", "reconcile-snapshot-absent", "snapshot-newer"]);
    const incompleteLineage = (rollup.derived.lineage || []).filter((l) => !COMPLETE_OUTCOMES.has(l.outcome));
    if (incompleteLineage.length > 0) {
      rollup.derived.skipped = "lineage-incomplete";
      rollup.derived.incomplete = incompleteLineage.map((l) => ({ reportKey: l.reportKey, accountId: l.accountId, outcome: l.outcome, detail: l.detail ?? null }));
      rollup.derived.resumable = incompleteLineage.some((l) => RESUMABLE_OUTCOMES.has(l.outcome));
      if (rollup.derived.resumable) rollup.continuationRequired = true;
    } else {
      rollup.derived.skipped = null;
    }
    // Sanitized blocker evidence: WHY a half is not ready, as [{sourceKey, reason, affected-account count}] --
    // never raw account/seller ids. asOf-clamp blockers (interior/leading historical gaps) fold in as
    // order-line-items reasons so a fail-closed publish date is visible in the release result.
    const sanitizeBlockers = (blockedBy) => {
      const byKey = new Map();
      for (const b of blockedBy || []) {
        const key = String(b.sourceKey) + "|" + String(b.reason);
        const cur = byKey.get(key) || { sourceKey: b.sourceKey, reason: b.reason, blocksSales: !!b.blocksSales, accounts: 0 };
        if (b.accountId) cur.accounts += 1;
        byKey.set(key, cur);
      }
      for (const b of effResolution.blockers || []) {
        const key = "order-line-items|asof-" + String(b.reason);
        const cur = byKey.get(key) || { sourceKey: "order-line-items", reason: "asof-" + String(b.reason), blocksSales: true, accounts: 0 };
        if (b.accountId) cur.accounts += 1;
        byKey.set(key, cur);
      }
      return [...byKey.values()];
    };
    rollup.derived.daily = { ready: derived.daily.readiness.ready, adsReady: derived.daily.readiness.adsReady, saved: dailySaved, skipped: derived.daily.skipped, blockedBy: sanitizeBlockers(derived.daily.readiness.blockedBy), effectivePublishAsOf, refreshAsOf };
    rollup.derived.brandView = { ready: derived.brandView.readiness.ready, adsReady: derived.brandView.readiness.adsReady, saved: brandViewSaved, skipped: derived.brandView.skipped, blockedBy: sanitizeBlockers(derived.brandView.readiness.blockedBy), effectivePublishAsOf, refreshAsOf };
    rollup.derived.brandInventory = brandInventory;

    // Round-6 fix 1: the source-first runtime NEVER finalizes the SHARED (bucket, cycle_date) cycle -- not
    // for a full bucket run, not for a narrowed subset. sync_cycles is ONE idempotent row per
    // (bucket, cycle_date) shared by EVERY Scheduler-v2 driver, and Migration 5's
    // reject_append_to_terminal_cycle trigger blocks ALL later child inserts/updates on a terminal cycle --
    // so a source-only run that terminalized the day's cycle would break every later same-day report run,
    // owner upsert, and source-card replay (the manual-subset hole at cycle level). "All Scheduler-v2 work
    // for this identity" is not knowable from inside a source-only run, so finalization stays where the
    // reviewed design put it: the CANONICAL SCHEDULED dispatcher finalizes ONLY a complete drained
    // SCHEDULED scope (sync-dispatch.js), and an explicit reviewed operation may close a cycle -- this
    // runtime does neither. The cycle's CURRENT status is reported from an honest READ (never written,
    // never fabricated); the publisher's terminal-cycle gate is satisfied only once the reviewed
    // finalization has genuinely happened.
    if (rollup.cycleId && typeof store.getCycle === "function") {
      try {
        const cycleRow = await dl.bound("cycle-status-read", (signal) => store.getCycle(rollup.cycleId, { signal }));
        rollup.cycleStatus = cycleRow && cycleRow.status ? cycleRow.status : null;
      } catch (e) { if (!dl.isDeadlineError(e)) throw e; /* status telemetry only; expiry never fails the run */ }
    }
    return rollup;
  };

  // FINDING 8 + round-5 blocker 3: the fail-closed evidence PREFLIGHT an endpoint runs BEFORE its first
  // write (including the audit row). EVERY read that can stop execution happens HERE -- controls, discovery,
  // coverage, snapshot pointers AND their hydration/integrity, Ads coverage, Ads metrics, the required
  // OLI-history evidence, membership, settings and rollout -- so an injected failure in ANY of them refuses
  // typed with ZERO audit/control/cycle/source/report/snapshot writes and ZERO exports. The returned bundle
  // is the ONE MEMOIZED preflight result: run({ preflight }) consumes it and repeats no discovery/read.
  // Round-5 blocker 4: `deadline` is the route-owned deadline created BEFORE this call; every read below is
  // bounded in-flight through it.
  const preflightEvidence = async ({ bucket = null, sourceKey = null, deadline = null, today = null } = {}) => {
    const dl = resolveDeadline(deadline);
    const controls = requireOkRead(await dl.bound("controls-read", (signal) => readSourceControls({ signal })), "source_controls");
    const pausedSources = new Set((controls.rows || []).filter((r) => r.paused === true).map((r) => r.source_key));
    if (sourceKey != null && pausedSources.has(sourceKey)) {
      const err = new Error(`SOURCE_PAUSED: "${sourceKey}" is paused; resume it before syncing missing data (fail closed).`);
      err.code = "SOURCE_PAUSED";
      err.status = 409;
      throw err;
    }
    if (bucket == null) return { pausedSources };
    const { connections, primary, orgFingerprint } = resolvePrimary();
    const { accounts, excluded, catalogCarrierSeller } = await dl.bound("discovery", () => discoverBucketAccounts({ connections, bucket }));
    const todayStr = today || new Date(clock()).toISOString().slice(0, 10);
    const asOfStr = asOfOverride || addDaysStr(todayStr, -1);
    // ONE hydrating evidence sweep (coverage + catalog/FBA pointers + hydration + integrity + staleness +
    // Ads coverage). Read failures surface as typed readBlockers; each read-failure class below is a HARD
    // typed refusal -- stale evidence is NOT one (it is the reviewed typed degrade that plans a refresh).
    const evidence = await gatherEvidence({ orgFingerprint, accounts, today: todayStr, bound: dl.bound });
    const refuse = (code, reason, blocker) => {
      const err = new Error(`${code}: preflight read "${reason}"${blocker && blocker.accountId ? ` (account ${blocker.accountId})` : ""} failed; refusing before any write (fail closed; zero-export).`);
      err.code = code;
      err.status = 503;
      throw err;
    };
    // SOURCE-SCOPED refusal set: a SINGLE-SOURCE action (sourceKey set) must not fail because an UNRELATED
    // source's evidence read is broken -- only the selected source itself plus the derive-REQUIRED shared inputs
    // (canonical OLI + the org Catalog: both block sales in the post-sync derive) may refuse. Ads/FBA/other
    // blockers on a scoped non-matching action are recorded evidence with their own typed degrades downstream
    // (the derive marks Ads failed / a snapshot absent) -- never a preflight hard-stop for a different source.
    // A FULL bucket run (sourceKey null) keeps the original refuse-on-anything-broken posture unchanged.
    const deriveRequiredKeys = new Set([OLI_SOURCE_KEY, CATALOG_SOURCE_KEY]);
    const blockerInScope = (b) => sourceKey == null || !b || !b.sourceKey || b.sourceKey === sourceKey || deriveRequiredKeys.has(b.sourceKey);
    for (const b of evidence.readBlockers) {
      if (!blockerInScope(b)) continue;
      const reason = String(b.reason || "");
      if (reason.endsWith("schema-missing")) refuse("DURABLE_MODEL_UNAVAILABLE", reason, b);
      if (reason === "snapshot-dangling") refuse("SNAPSHOT_HYDRATION_FAILED", reason, b);
      if (reason === "snapshot-integrity") refuse("SNAPSHOT_INTEGRITY_FAILED", reason, b);
      // A stale daily snapshot is valid evidence that its source needs a refresh, not a failed read. The
      // validator deliberately drops its rows so the planner sees the source as absent and schedules that
      // source when it is in scope. In a narrowed OLI-only run Catalog/FBA are paused, so their staleness must
      // not block OLI before the first create. Genuine snapshot transport/schema/integrity failures still
      // refuse above/below.
      if (reason === "snapshot-stale") continue;
      if (reason.startsWith("ads-coverage-")) refuse("ADS_COVERAGE_READ_FAILED", reason, b);
      if (reason.startsWith("coverage-") || reason.startsWith("snapshot-")) refuse("SOURCE_EVIDENCE_READ_FAILED", reason, b);
    }
    // Ads metrics: the typed read state is CAPTURED here (memoized). For a FULL run (or an ads-scoped action) an
    // infrastructure read failure refuses BEFORE any write; for a SCOPED NON-ads action (OLI/Catalog card) it is
    // recorded as the typed "read-failed" degrade instead -- the post-sync derive marks Ads failed while sales
    // still save, so an unrelated ads read blip can never block the selected source's sync. limit-exceeded is a
    // VALID authoritative answer and stays a typed degrade everywhere.
    const adsReadMayDegrade = sourceKey != null && sourceKey !== "ads-asin-date" && sourceKey !== "ads-campaign-date";
    const dailyWindow = { from: monthBackStr(asOfStr, 5), to: asOfStr };
    const adMetricsByAccountId = {};
    for (const a of accounts) {
      try {
        const rows = await dl.bound("ads-metrics-load", (signal) => readAdMetrics(a.accountId, dailyWindow.from, dailyWindow.to, { signal }));
        if (!Array.isArray(rows)) {
          if (adsReadMayDegrade) { adMetricsByAccountId[a.accountId] = { rows: [], metricsRead: "read-failed" }; continue; }
          refuse("ADS_METRICS_READ_FAILED", "ads-metrics-malformed", { accountId: a.accountId });
        }
        adMetricsByAccountId[a.accountId] = { rows, metricsRead: "ok" };
      } catch (e) {
        if (dl.isDeadlineError(e) || (e && e.code === "ADS_METRICS_READ_FAILED")) throw e;
        if (e && e.code === "ADS_ROW_LIMIT_EXCEEDED") {
          adMetricsByAccountId[a.accountId] = { rows: [], metricsRead: "limit-exceeded" };
        } else if (adsReadMayDegrade) {
          adMetricsByAccountId[a.accountId] = { rows: [], metricsRead: "read-failed" };
        } else {
          refuse("ADS_METRICS_READ_FAILED", "ads-metrics-read", { accountId: a.accountId });
        }
      }
    }
    // The required OLI-history evidence (the derive stage's input): unreadable history refuses here.
    const brandViewWindow = oliBackfillWindow(asOfStr);
    let historyRows = null;
    try {
      historyRows = await dl.bound("history-load", (signal) => loadHistoryRows({
        organizationFingerprint: orgFingerprint, connectionId: "primary",
        accountIds: accounts.map((a) => a.accountId),
        from: brandViewWindow.from, to: brandViewWindow.to,
        signal,
      }));
    } catch (e) {
      if (dl.isDeadlineError(e)) throw e;
      historyRows = null;
    }
    if (!Array.isArray(historyRows)) refuse("HISTORY_READ_FAILED", "oli-history", null);
    let membershipRows;
    try { membershipRows = await dl.bound("membership-read", (signal) => readBatchMembership(oliBatchFamily({ orgFingerprint, bucket }), { signal })); }
    catch (e) {
      if (dl.isDeadlineError(e)) throw e;
      const err = new Error("BATCH_MEMBERSHIP_READ_FAILED: durable source_batch_membership could not be read; refusing before any write (fail closed).");
      err.code = "BATCH_MEMBERSHIP_READ_FAILED"; err.status = 503; throw err;
    }
    const membership = validateBatchMembershipRows(membershipRows, { orgFingerprint });
    let settings;
    try { settings = await dl.bound("settings-read", (signal) => readSettings({ signal })); } catch (e) { if (dl.isDeadlineError(e)) throw e; settings = null; }
    if (!Array.isArray(settings)) {
      const err = new Error("SETTINGS_READ_FAILED: report_sync_settings could not be read; refusing before any write (fail closed).");
      err.code = "SETTINGS_READ_FAILED"; err.status = 503; throw err;
    }
    const rollout = await (async () => { try { return await dl.bound("rollout-read", (signal) => readRollout({ signal })); } catch (e) { if (dl.isDeadlineError(e)) throw e; return null; } })();
    if (!rollout || rollout.read !== "ok") {
      const err = new Error("ROLLOUT_READ_FAILED: the durable account rollout could not be read; refusing before any write (fail closed).");
      err.code = "ROLLOUT_READ_FAILED"; err.status = 503; throw err;
    }
    return {
      pausedSources, bucket, sourceKey,
      connections, primary, orgFingerprint,
      accounts, excluded, catalogCarrierSeller,
      membership,
      evidence,
      historyRows,
      adMetricsByAccountId,
      settings, rollout,
      today: todayStr, asOf: asOfStr,
    };
  };

  const runSourceCardAction = async ({ bucket, sourceKey, reuseOnly = false, deadline = null, preflight = null, forceFreshOli = false } = {}) => {
    const entry = sourceRegistryEntry(sourceKey); // typed UNREGISTERED_SOURCE (fail closed)
    // FORCE-FRESH-OLI is authorized ONLY for the order-line-items family (the D-1 "force latest" re-fetch). It is a
    // trusted operator/composition argument (the admin DSC + the GitHub force-latest job), never an ordinary read.
    const freshOli = forceFreshOli === true && sourceKey === "order-line-items";
    if (bucket !== "us" && bucket !== "non-us") {
      throw new Error(`runSourceCardAction requires bucket 'us'|'non-us' (got "${bucket}").`);
    }
    // Round-5 blockers 3+4: ONE route-owned deadline (created by the route BEFORE preflight when this is
    // endpoint-driven) and ONE memoized preflight. A caller that already preflighted passes the bundle
    // through; a direct caller still gets the uniform controls-first guarantee here.
    const dl = resolveDeadline(deadline);
    const pf = preflight && preflight.bucket === bucket ? preflight : await preflightEvidence({ bucket, sourceKey, deadline: dl });
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
      return run({ bucket, onlySourceKey: sourceKey, reuseOnly, deadline: dl, preflight: pf, forceFreshOli: freshOli });
    }
    // FINDING 1: a cycle-cache family executes ONLY its own canonical source family -- the trusted
    // per-tranche composition FIXED to exactly this family (the full plan is still upserted; execution
    // narrows to the family, so the action can never widen into unrelated dependencies), honoring
    // reuseOnly (the composition installs the create-export tripwire in rehearsal). Bounded continuations
    // under the shared deadline; an expired budget is typed resumable.
    const deadlineMs = dl.deadlineMs; // the ONE route-owned deadline (created before preflight)
    const outOfTime = dl.outOfTime;
    const todayStr = new Date(dl.startMs).toISOString().slice(0, 10);
    const asOfStr = addDaysStr(todayStr, -1);
    const runtime = composeTrancheRuntime({ name: sourceKey, sourceKeys: [sourceKey] }, { reuseOnly: reuseOnly === true });
    const store = makeSourceStore({ deadline: dl });
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
        clock, deadlineMs, reserveMs: dl.reserveMs, trigger: "manual",
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
    const refreshAsOf = asOf || addDaysStr(todayStr, -1);
    const evidence = await gatherEvidence({ orgFingerprint, accounts: ids.map((accountId) => ({ accountId })), today: todayStr });
    // SAME requested-vs-effective as-of resolution the derive uses: clamp a recent unsettled tail back to the
    // latest common proven completed date; an interior/leading historical gap leaves the effective date null so
    // readiness fails closed at refreshAsOf. Manual + scheduled readiness therefore agree exactly.
    const backfillFrom = oliBackfillWindow(refreshAsOf).from;
    const effResolution = resolveEffectivePublishAsOf({
      coverageByAccountId: evidence.oliCoverageByAccountId, accountIds: ids, from: backfillFrom, refreshAsOf,
    });
    const effectivePublishAsOf = effResolution.effectiveAsOf || refreshAsOf;
    const dailyWindow = { from: monthBackStr(effectivePublishAsOf, 5), to: effectivePublishAsOf };
    const brandViewWindow = { from: backfillFrom, to: effectivePublishAsOf };
    const daily = dailyReportingReadiness({
      accounts: ids, oliCoverageByAccountId: evidence.oliCoverageByAccountId,
      catalogSnapshot: evidence.catalogSnapshot, asinAds: evidence.asinAds,
      from: dailyWindow.from, to: dailyWindow.to,
    });
    const brandView = brandViewReadiness({
      accounts: ids, oliCoverageByAccountId: evidence.oliCoverageByAccountId,
      catalogSnapshot: evidence.catalogSnapshot, asinAds: evidence.asinAds,
      fbaSnapshotsByAccount: evidence.fbaSnapshotsByAccount,
      from: brandViewWindow.from, to: brandViewWindow.to,
    });
    // Merge the typed read-failure blockers AND the asOf-clamp blockers so neither a failed read nor an interior
    // historical hole can ever present as healthy evidence.
    const asOfBlocked = (effResolution.blockers || []).map((b) => ({ sourceKey: "order-line-items", reason: "asof-" + String(b.reason), accountId: b.accountId ?? undefined, blocksSales: true }));
    const merge = (r, keys) => {
      const readBlocked = evidence.readBlockers.filter((b) => keys.includes(b.sourceKey));
      const blockedBy = [...readBlocked, ...asOfBlocked, ...r.blockedBy];
      return { ...r, blockedBy, ready: r.ready && !readBlocked.some((b) => b.blocksSales) && asOfBlocked.length === 0 };
    };
    return {
      asOf: effectivePublishAsOf, refreshAsOf, effectivePublishAsOf, asOfClamped: effectivePublishAsOf !== refreshAsOf,
      daily: merge(daily, ["order-line-items", "product-catalog", "ads-asin-date"]),
      brandView: merge(brandView, ["order-line-items", "product-catalog", "ads-asin-date", "fba-inventory-health"]),
    };
  };

  return { run, runSourceCardAction, gatherDurableReadiness, preflightEvidence, makeDeadline };
}
