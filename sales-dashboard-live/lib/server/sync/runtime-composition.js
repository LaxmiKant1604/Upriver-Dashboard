// Scheduler v2 Phase 1f -- PRODUCTION RUNTIME COMPOSITION + no-side-effect preflight (SHADOW MODE).
//
// ONE place that wires the approved Phase 1e dispatcher (runSchedulerV2Shadow) to the EXISTING production
// primitives -- the Supabase source + report stores, the DataDoe adapter, the cache-only source-row loader,
// the shadow snapshot saver, the Daily Ads coverage loader, the PPC persisted-Ads readers, and dynamic
// primary-account discovery. It is PURELY COMPOSITIONAL:
//   - construction performs ZERO I/O: every collaborator is a closure/adapter that is assembled but NEVER
//     invoked here (no DataDoe export, no Supabase read/write, no account discovery happens at build time);
//   - it creates NO route, cron, deployment, migration, or frontend wiring and unlocks NO control;
//   - the control plane defaults to the fail-closed schedulerV2ReportControlCatalog, so a real invocation of
//     the composed runtime dispatches NOTHING and spends zero tokens until a v2 control is deliberately
//     unlocked (a reviewed cutover, never done here).
// Every production primitive is INJECTABLE so the whole composition is deterministically offline-testable.

import { getDataDoeConnections, mergeDiscoveredDataDoeAccounts } from "../datadoe-connections.js";
import { fetchAccounts as fetchDataDoeAccounts } from "../datadoe.js";
import { makeSupabaseSourceStore, makeDataDoeAdapter } from "./source-sync-driver.js";
import { makeSupabaseReportStore, makeSourceRowLoader, makeShadowSnapshotSaver } from "./report-snapshot-store.js";
import { makeDailyAdsContextLoader } from "./daily-ads-loader.js";
import { makeFbaPlanDurableContextLoader } from "./fba-plan-durable-loader.js";
import { schedulerV2ReportControlCatalog, CONTROLLED_REPORT_KEYS, SCHEDULER_V2_READY_REPORT_KEYS } from "./report-controls.js";
import { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } from "./report-publisher.js";
import { runSchedulerV2Shadow } from "./sync-dispatch.js";
import { makeSourceTranche, isSourceTranche } from "./source-tranche.js";
import { getAsinAdsDailyRows, getDailyAdsCoverage, getAdsDailySourceRows, getAdsSyncStates, getReportSyncSettings, getSchedulerAccountRollout, getSourceCoverageWindows, getSourceOliHistoryRows, getSourceSnapshot, getSourceSnapshotPayload } from "../supabase.js";
import { auditSchemaContract, schedulerV2SchemaObjects, REQUIRED_WRAPPER_EXPORTS } from "./schema-contract.js";

// The complete set of Supabase wrappers the composed runtime depends on. Re-exported from the schema contract
// (the single source of truth the static audit also proves every one of); back-compat name for callers/tests.
export const REQUIRED_WRAPPERS = REQUIRED_WRAPPER_EXPORTS;

// The ONLY per-run arguments a caller may supply to rt.run(). Every trusted collaborator (control plane,
// routing, stores, saver, loaders, and the durable settings) is fixed by the composition and can NOT be
// overridden per run (blocker 2). Test injection happens at buildSchedulerV2Runtime(overrides), never per run.
export const RUN_OPERATIONAL_ARGS = Object.freeze([
  "bucket", "cycleDate", "asOf", "asOfFor", "manualReportKeys",
  "clock", "deadlineMs", "reserveMs", "maxJobs", "scheduledAt", "trigger",
]);

// The single Daily Ads source_key ad_daily_metrics is keyed under (mirrors daily-ads-loader.DAILY_ADS_SOURCE_KEY).
export { DAILY_ADS_SOURCE_KEY } from "./daily-ads-loader.js";

/**
 * Combine several named store interfaces into ONE, EXPLICITLY and FAIL-CLOSED. Two stores that expose the
 * SAME method name are a CONFLICT and abort the combination -- one implementation is NEVER silently overwritten
 * by another -- UNLESS that name is on the `shared` allowlist (an INTENTIONAL, documented overlap where both
 * stores map to the identical underlying wrapper; the first store's method is kept as canonical). Every value
 * combined must be a function (a non-function store member is refused). `namedStores`: [{ label, store }].
 */
export function combineStores(namedStores, { shared = [] } = {}) {
  const sharedSet = new Set(shared);
  const combined = {};
  const owner = {};
  for (const entry of namedStores || []) {
    const label = entry && entry.label;
    const store = entry && entry.store;
    if (!label || !store || typeof store !== "object") {
      throw new Error("combineStores requires entries of the shape { label, store:object }.");
    }
    for (const name of Object.keys(store)) {
      const fn = store[name];
      if (typeof fn !== "function") {
        throw new Error(`combineStores: store "${label}" member "${name}" is not a function; refusing to combine (fail closed).`);
      }
      if (name in combined) {
        if (sharedSet.has(name)) continue; // intentional shared overlap: keep the first (canonical) implementation
        throw new Error(`combineStores: conflicting method "${name}" is defined by BOTH "${owner[name]}" and "${label}"; refusing to silently overwrite one implementation with another (fail closed).`);
      }
      combined[name] = fn;
      owner[name] = label;
    }
  }
  // Every declared shared name MUST actually have appeared (a typo in `shared` should not pass silently).
  for (const name of sharedSet) {
    if (!(name in combined)) throw new Error(`combineStores: shared method "${name}" was declared but no store provided it.`);
  }
  return combined;
}

/**
 * Build the PRODUCTION discoverAccounts() provider: dynamic, primary-only-safe, FAIL-CLOSED.
 *   - discovers the CURRENT accounts of every CONFIGURED connection (a newly connected primary account appears
 *     automatically -- no code change), merged onto public, connection-scoped ids (dd-secondary keeps its
 *     prefix). The dispatcher's classifyDirectoryAccounts then enforces primary-only routing: a dormant
 *     dd-secondary account (secondary org retired) is skipped read-only and NEVER routed through the primary key;
 *   - a discovery failure for ANY connection THROWS, and because the dispatcher awaits discoverAccounts() BEFORE
 *     opening any cycle, discovery failure fails closed BEFORE a single source export is created.
 * The account list read is a DataDoe accounts GET (never an export); it is WIRED here but NOT invoked until the
 * composed runtime is actually run (a future, approval-gated live step). `fetchAccounts` is injectable.
 */
export function makeProductionDiscoverAccounts({ connections, fetchAccounts = fetchDataDoeAccounts } = {}) {
  if (typeof fetchAccounts !== "function") {
    throw new Error("makeProductionDiscoverAccounts requires an injected fetchAccounts(apiKey) reader.");
  }
  const resolveConnections = typeof connections === "function" ? connections : () => connections;
  return async () => {
    const conns = resolveConnections() || [];
    const byConnection = [];
    for (const connection of conns) {
      if (!connection || !connection.apiKey) continue; // never fetch a connection without a configured key
      // No try/catch: a throw here propagates through the dispatcher's `await discoverAccounts()` and aborts
      // the whole invocation BEFORE step 4 (any source export). Fail closed, never a partial/guessed directory.
      const accounts = await fetchAccounts(connection.apiKey);
      byConnection.push({ connection, accounts: accounts || [] });
    }
    return mergeDiscoveredDataDoeAccounts(byConnection);
  };
}

// Blocker 3: the create-export TRIPWIRE. In reuseOnly rehearsal a create-export POST must NEVER happen. This
// wrapper lets poll/download through unchanged (resuming an already-saved export_id via GET/status/raw is
// always allowed) but makes any create-export attempt throw loudly, so not even a future worker bug can spend
// a token during zero-token rehearsal. It is defense in depth on top of the worker's own reuseOnly gate.
function withCreateExportTripwire(adapter) {
  return {
    ...adapter,
    create: async () => {
      throw new Error("CREATE_EXPORT_TRIPWIRE: reuseOnly rehearsal attempted a DataDoe create-export; refusing (zero-token rehearsal).");
    },
  };
}

/**
 * Assemble the full set of injected collaborators runSchedulerV2Shadow needs, from production primitives.
 * Returns `{ connections, store, dataDoe, saveSnapshot, sourceRowLoader, ppcAdsProviders, loadDerivedContext,
 * discoverAccounts, controlCatalog, run }` where `run(sliceArgs)` invokes the dispatcher with these
 * collaborators (the caller still supplies bucket/cycleDate/asOf/budget/trigger). Construction is ZERO-I/O:
 * every factory returns closures and nothing is invoked. Every primitive is injectable (production defaults).
 *
 * The combined `store` merges the Supabase SOURCE store and REPORT store EXPLICITLY (combineStores), sharing
 * only `listSourceJobs` (both wrappers are the identical getSyncSourceJobs). The derive reads source rows
 * cache-only through `store.loadSourceRows` (== getSourceExportCache, the same reader makeSourceRowLoader
 * returns) -- NEVER a DataDoe export. Snapshot saves stay scheduler-v2/* shadow-namespaced (makeShadowSnapshotSaver).
 */
export function buildSchedulerV2Runtime(overrides = {}) {
  const {
    connections: connectionsOverride,
    getConnections = getDataDoeConnections,
    makeSourceStore = makeSupabaseSourceStore,
    makeReportStore = makeSupabaseReportStore,
    makeDataDoeAdapter: makeAdapter = makeDataDoeAdapter,
    makeSourceRowLoader: sourceRowLoaderFactory = makeSourceRowLoader,
    makeShadowSnapshotSaver: snapshotSaverFactory = makeShadowSnapshotSaver,
    controlCatalog = schedulerV2ReportControlCatalog,
    fetchAccounts = fetchDataDoeAccounts,
    getReportSyncSettings: readReportSyncSettings = getReportSyncSettings, // DURABLE scheduled-control source
    getAccountRollout = getSchedulerAccountRollout, // DURABLE account-rollout source (Gate-7; fail-closed typed reader)
    // Ads readers -- ALL Supabase, cache-only; NEVER a DataDoe export:
    getAdMetrics = getAsinAdsDailyRows,           // Daily Reporting durable ASIN Ads reader (single reusable source)
    getCoverageState = getDailyAdsCoverage,        // Daily durable ads_sync_coverage reader
    getAdsDailySourceRows: ppcRows = getAdsDailySourceRows,   // PPC persisted Ads rows reader
    getAdsSyncStates: ppcStates = getAdsSyncStates,           // PPC ads_sync_state reader
    getAdsSyncCoverage: ppcCoverage = getDailyAdsCoverage,    // PPC durable coverage reader (same generic reader)
    // fba-plan durable OLI + Catalog readers -- ALL Supabase, cache-only; NEVER a DataDoe export:
    getSourceCoverageWindows: readOliCoverage = getSourceCoverageWindows, // durable OLI coverage windows (fail-closed gate)
    getSourceOliHistoryRows: readOliHistory = getSourceOliHistoryRows,     // durable OLI daily history rows
    getSourceSnapshot: readCatalogSnapshot = getSourceSnapshot,            // durable org Product Catalog snapshot pointer
    getSourceSnapshotPayload: loadCatalogPayload = getSourceSnapshotPayload, // durable catalog storage payload
    // BUILD-TIME source-tranche selector (Part A). null => execute every source family (unchanged). A raw
    // spec is normalized via makeSourceTranche; an already-built descriptor passes through unchanged. It is
    // fixed HERE (a trusted collaborator), NEVER on RUN_OPERATIONAL_ARGS, so no per-run caller can set it.
    sourceTranche = null,
    // BUILD-TIME reuseOnly REHEARSAL flag (Blocker 3). true => zero-token rehearsal: the worker only reuses a
    // durable cache adoption or a saved export_id, and the DataDoe adapter is wrapped with a create-export
    // TRIPWIRE so any create POST throws. Fixed HERE (trusted), NEVER on RUN_OPERATIONAL_ARGS.
    reuseOnly = false,
    // BUILD-TIME budget planner (Blocker 4d wiring): { isPremiumOf(job), trancheBudgetMode(spec) }. When
    // fixed here together with a statically-plannable sourceKeys tranche, the dispatcher freezes + threads
    // the GENERIC unit's create/AI-token ceilings (see runSchedulerV2Shadow). Fixed HERE (trusted), NEVER on
    // RUN_OPERATIONAL_ARGS; a malformed planner fails closed at compose time. null => byte-identical.
    budgetPlanner = null,
  } = overrides;

  if (budgetPlanner != null && (typeof budgetPlanner !== "object"
    || typeof budgetPlanner.isPremiumOf !== "function" || typeof budgetPlanner.trancheBudgetMode !== "function")) {
    throw new Error("buildSchedulerV2Runtime: budgetPlanner, when supplied, must be { isPremiumOf(job), trancheBudgetMode(spec) } (fail closed).");
  }

  const normalizedSourceTranche = sourceTranche == null
    ? null
    : (isSourceTranche(sourceTranche) ? sourceTranche : makeSourceTranche(sourceTranche));
  const reuseOnlyMode = !!reuseOnly;

  // Resolve connections ONCE (an env read via getDataDoeConnections, or an injected array). No network/db.
  const connections = connectionsOverride != null ? connectionsOverride : getConnections();

  // Combine the two Supabase store interfaces EXPLICITLY (fail-closed on any non-shared method-name conflict).
  const store = combineStores(
    [
      { label: "source", store: makeSourceStore() },
      { label: "report", store: makeReportStore() },
    ],
    { shared: ["listSourceJobs"] }, // both are the identical getSyncSourceJobs wrapper (source store is canonical)
  );

  // Blocker 3: in reuseOnly rehearsal the adapter is wrapped with a create-export TRIPWIRE (poll/download of
  // an already-saved export_id still pass; only create-export POSTs throw), so not even a worker bug can spend
  // a token. The worker's own reuseOnly gate returns MISSING_REUSABLE_SOURCE before create is ever reached;
  // this is defense in depth. A non-reuseOnly runtime uses the ordinary adapter unchanged.
  const dataDoe = reuseOnlyMode ? withCreateExportTripwire(makeAdapter(connections)) : makeAdapter(connections);
  const saveSnapshot = snapshotSaverFactory();        // writes ONLY under the scheduler-v2/* shadow namespace
  const sourceRowLoader = sourceRowLoaderFactory();    // cache-only getSourceExportCache (== store.loadSourceRows)
  const ppcAdsProviders = { getAdsDailySourceRows: ppcRows, getAdsSyncStates: ppcStates, getAdsSyncCoverage: ppcCoverage };
  // Report-scoped derived-context loaders: each returns {} for reports it does not own, so a shallow merge is a
  // safe union (no report is claimed by two loaders). fba-plan reads its DERIVED durable OLI + Catalog here.
  const dailyAdsLoader = makeDailyAdsContextLoader({ connections, getAdMetrics, getCoverageState });
  const fbaPlanDurableLoader = makeFbaPlanDurableContextLoader({ connections, getOliCoverage: readOliCoverage, getOliHistory: readOliHistory, getCatalogSnapshot: readCatalogSnapshot, loadCatalogPayload });
  const loadDerivedContext = async (args) => ({ ...(await dailyAdsLoader(args)), ...(await fbaPlanDurableLoader(args)) });
  const discoverAccounts = makeProductionDiscoverAccounts({ connections, fetchAccounts });
  // Gate-7 durable ACCOUNT gate loader (the dispatcher enforces it on EVERY dispatch, scheduled AND manual --
  // manualReportKeys selects reports only, never accounts). Trusted + fixed: RUN_OPERATIONAL_ARGS does not
  // include it, so a per-run caller can never widen (or narrow) account scope.
  const loadAccountRollout = async () => getAccountRollout();

  // TRUSTED collaborators -- fixed by the composition; a per-run caller can NEVER override any of them.
  const collaborators = { connections, store, dataDoe, saveSnapshot, ppcAdsProviders, loadDerivedContext, discoverAccounts, controlCatalog, loadAccountRollout, sourceTranche: normalizedSourceTranche, reuseOnly: reuseOnlyMode, budgetPlanner };

  // Load the DURABLE report scheduling controls (report_sync_settings) -- the ONLY production control source
  // for the scheduled path. A read failure THROWS here, so it fails closed BEFORE runSchedulerV2Shadow does
  // any discovery / cycle creation / Supabase write / DataDoe export.
  const loadDurableSettings = async () => {
    const rows = await readReportSyncSettings();
    return Array.isArray(rows) ? rows : [];
  };

  return {
    ...collaborators,
    sourceRowLoader,
    /**
     * Run one bounded SHADOW dispatch slice. The caller supplies ONLY operational args (bucket / cycleDate /
     * asOf(/asOfFor) / manualReportKeys / budget / trigger) -- every other key is DROPPED (blocker 2): a
     * caller can never override the control catalog, connections, discovery, stores, saver, loaders, or the
     * durable settings, so a per-run override cannot unlock a report, change organization routing, or replace
     * the shadow saver. A SCHEDULED run (no manualReportKeys) loads the durable report_sync_settings first and
     * fails closed on a read error before any I/O (blocker 1); a MANUAL run stays readiness-gated and needs no
     * durable settings. Trusted collaborators + the durable settings are spread LAST so nothing can shadow them.
     */
    run: async (sliceArgs = {}) => {
      const operational = {};
      for (const k of RUN_OPERATIONAL_ARGS) if (sliceArgs != null && k in sliceArgs) operational[k] = sliceArgs[k];
      // Fix 3: classify manual vs scheduled BEFORE any settings I/O. null/undefined => scheduled; an Array
      // (including []) => manual. ANY other value is a MALFORMED manual request that fails closed IMMEDIATELY
      // -- zero settings reads, discovery, store calls, writes, or DataDoe calls. (The dispatcher re-validates
      // it too, but that runs only AFTER the durable settings load, so this pre-check keeps the read off.)
      const mrk = operational.manualReportKeys;
      if (mrk != null && !Array.isArray(mrk)) {
        throw new Error(`buildSchedulerV2Runtime.run: manualReportKeys must be null/undefined (scheduled) or an array (manual, including []); got ${typeof mrk}. Refusing (fail closed).`);
      }
      const manual = Array.isArray(mrk);
      // Durable, trusted settings for the scheduled path (never caller-supplied). Loaded (and possibly
      // failing closed) BEFORE the dispatcher touches discovery/cycle/store/DataDoe.
      const settings = manual ? [] : await loadDurableSettings();
      return runSchedulerV2Shadow({ ...operational, settings, ...collaborators });
    },
  };
}

/**
 * BUILD-TIME trusted CANARY composition (Gate-5/6 style isolated shadow canaries). The operator's reviewed
 * account scope is fixed HERE, at composition time, as EXACT public account ids -- there is NO per-run
 * account-scope argument and NO rollout bypass: the composed runtime's trusted rollout loader returns an
 * allowlist of exactly these ids, and the dispatcher still intersects them with FRESH primary discovery on
 * every run (an id that is not a currently discovered ACTIVE PRIMARY account selects nothing; dd-secondary
 * is rejected up front). Everything else -- stores, adapters, saver, control catalog (still fail-closed),
 * report readiness -- is the ordinary trusted composition; reports must STILL be selected explicitly
 * (manualReportKeys) and remain readiness-gated.
 */
export function buildSchedulerV2CanaryRuntime(overrides = {}) {
  const { canaryAccountIds, ...rest } = overrides;
  if (!Array.isArray(canaryAccountIds) || canaryAccountIds.length === 0) {
    throw new Error("buildSchedulerV2CanaryRuntime requires canaryAccountIds: a non-empty array of exact public account ids (build-time, reviewed).");
  }
  // Reject -- never NORMALIZE -- a noncanonical id: each must be a string with NO leading/trailing whitespace,
  // nonblank, and not dd-secondary-prefixed. Trimming a reviewed id could silently point the canary at a
  // DIFFERENT account, so a noncanonical id is a composition error the operator must fix in the reviewed list.
  for (const id of canaryAccountIds) {
    if (typeof id !== "string" || id !== id.trim() || id.trim().length === 0 || id.startsWith("dd-secondary:")) {
      throw new Error("buildSchedulerV2CanaryRuntime: every canary account id must be a nonblank exact PRIMARY public id -- a string with NO leading/trailing whitespace and no dd-secondary prefix (ids are NOT normalized); refusing to compose (fail closed).");
    }
  }
  // Reject DUPLICATE ids: a duplicated reviewed id is an authoring mistake, never silently deduplicated.
  if (new Set(canaryAccountIds).size !== canaryAccountIds.length) {
    throw new Error("buildSchedulerV2CanaryRuntime: duplicate canary account id(s); refusing to compose (fail closed).");
  }
  // The canary's account scope IS its rollout state -- fixed at build time; the dispatcher still validates
  // each id against fresh primary discovery on every run. `rest` may not smuggle a different rollout source.
  delete rest.getAccountRollout;
  return buildSchedulerV2Runtime({
    ...rest,
    getAccountRollout: async () => ({ read: "ok", allPrimary: false, enabledAccountIds: [...canaryAccountIds] }),
  });
}

/**
 * BUILD-TIME trusted SOURCE-TRANCHE composition (Part A). A reviewed operator invokes this ONCE per tranche
 * in SOURCE_TRANCHE_ORDER to drain the canonical source families one at a time. The tranche is FIXED here at
 * compose time (mirrors buildSchedulerV2CanaryRuntime): any `sourceTranche` smuggled in `overrides` is deleted
 * so it can never be widened, and the built descriptor is threaded through as a trusted collaborator (never on
 * RUN_OPERATIONAL_ARGS). Everything else is the ordinary trusted composition -- reports stay readiness-gated,
 * accounts stay rollout-gated, and the source half still upserts the FULL plan while executing only the
 * selected families, so the next tranche resumes the same (bucket, cycle_date) cycle with no duplicate export.
 */
export function buildSchedulerV2SourceTrancheRuntime(spec, overrides = {}) {
  const rest = { ...overrides };
  delete rest.sourceTranche; // FIX the tranche at compose time; reject any smuggled per-run/override tranche.
  return buildSchedulerV2Runtime({ ...rest, sourceTranche: makeSourceTranche(spec) });
}

// The required env keys the Scheduler-v2 runtime needs (names only -- values are NEVER read into telemetry).
export const REQUIRED_RUNTIME_ENV = Object.freeze(["DATADOE_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);

/**
 * NO-SIDE-EFFECT runtime preflight. Validates -- WITHOUT creating a DataDoe export, discovering accounts, or
 * writing anything -- that the Scheduler-v2 runtime is safe to (eventually) turn on:
 *   1. required environment/configuration is present;
 *   2. a primary DataDoe connection is configured;
 *   3. the required Supabase wrappers are available;
 *   4. the required Scheduler-v2 tables/RPCs are declared and match the calling wrappers (static schema audit);
 *   5. the four unapplied migrations are present + contract-compatible (migration readiness);
 *   6a. the EXPLICIT v2 readiness allowlist is exactly 13 unique keys, each a controlled report with a live
 *       snapshot contract (fail closed with V2_READINESS_COUNT/_DUPLICATE/_UNKNOWN/_NO_CONTRACT); and
 *   6b. the catalog's ready set is a SUBSET of that literal and nothing is scheduled with empty settings
 *       (fail closed with V2_CONTROLS_UNLOCKED) -- so a future controlled report not in the literal stays not-ready.
 * Returns `{ ready, blockers, checks, expected }`. `blockers` carry ONLY typed, SAFE codes + operator messages
 * -- never an api key, a raw Supabase/DataDoe error, or a secret. It performs no write and no DataDoe export.
 *
 * Everything is injectable: `env`, `getConnections`, `controlCatalog`, `wrappers` (the wrapper module, to
 * verify each is a function), and `readFile` (for the static schema audit). Omitting `readFile` yields a typed
 * SCHEMA_AUDIT_UNAVAILABLE blocker rather than a vacuous pass.
 */
export function schedulerV2Preflight(overrides = {}) {
  const {
    env = process.env,
    getConnections = getDataDoeConnections,
    controlCatalog = schedulerV2ReportControlCatalog,
    wrappers = null,
    requiredWrappers = REQUIRED_WRAPPERS,
    readFile = null,
    // The EXPLICIT v2 readiness allowlist to validate. Production passes nothing => the frozen literal; a
    // test may inject a malformed list to prove the typed readiness blockers fire (build-time seam only).
    readyKeys = SCHEDULER_V2_READY_REPORT_KEYS,
  } = overrides;

  const blockers = [];
  const checks = {};
  const push = (b) => blockers.push(b);

  // 1) required env/config -- report only the missing KEY NAMES, never a value.
  const missingEnv = REQUIRED_RUNTIME_ENV.filter((k) => !String((env && env[k]) || "").trim());
  checks.env = { required: [...REQUIRED_RUNTIME_ENV], missing: missingEnv, ok: missingEnv.length === 0 };
  if (missingEnv.length) push({ code: "ENV_MISSING", keys: missingEnv, message: `required configuration missing: ${missingEnv.join(", ")}` });

  // 2) primary DataDoe connection -- a thrown "not configured" is mapped to a typed code (raw message dropped).
  let hasPrimary = false;
  try {
    const conns = getConnections() || [];
    hasPrimary = Array.isArray(conns) && conns.some((c) => c && c.id === "primary" && String(c.apiKey || "").trim());
  } catch (_e) {
    hasPrimary = false;
  }
  checks.primaryConnection = { ok: hasPrimary };
  if (!hasPrimary) push({ code: "PRIMARY_CONNECTION_MISSING", message: "primary DataDoe connection is not configured" });

  // Run the STATIC schema<->wrapper audit ONCE (no db/network). It covers the required tables/RPCs/migration
  // readiness AND proves EVERY required wrapper is exported, so wrapper availability is never claimed vacuously.
  const expected = schedulerV2SchemaObjects();
  let audit = null;
  if (typeof readFile === "function") {
    try { audit = auditSchemaContract({ readFile }); } catch (_e) { audit = { ok: false, matrix: [], blockers: [{ code: "AUDIT_FAILED", message: "schema audit could not run" }], requiredWrappers: { total: 0, missing: [], ok: false } }; }
    // Fix 2: DEFENSIVELY normalize the result so a malformed/partial audit can NEVER crash the preflight with a
    // TypeError (audit.requiredWrappers / audit.blockers / audit.matrix). Missing pieces become fail-closed
    // defaults + an AUDIT_MALFORMED blocker, so an unexpected shape fails closed rather than passing vacuously.
    const rw = audit && audit.requiredWrappers;
    const malformed = !audit || !Array.isArray(audit.blockers) || !Array.isArray(audit.matrix)
      || !rw || typeof rw !== "object" || !Array.isArray(rw.missing);
    audit = {
      ok: !!audit && audit.ok === true && !malformed,
      matrix: audit && Array.isArray(audit.matrix) ? audit.matrix : [],
      blockers: audit && Array.isArray(audit.blockers) ? audit.blockers.slice() : [],
      requiredWrappers: rw && Array.isArray(rw.missing) ? { total: Number(rw.total) || 0, missing: rw.missing, ok: rw.ok === true } : { total: 0, missing: [], ok: false },
    };
    if (malformed) audit.blockers.push({ code: "AUDIT_MALFORMED", message: "schema audit returned a malformed result; failing closed" });
  }

  // 3) Supabase wrapper availability. With an injected wrapper module: a runtime typeof check. Otherwise: the
  //    static audit's SOURCE-LEVEL export proof (covering EVERY required wrapper). With NEITHER, availability is
  //    UNPROVEN and fails closed -- never claimed proven vacuously (blocker 3).
  if (wrappers) {
    const missingWrappers = requiredWrappers.filter((n) => typeof wrappers[n] !== "function");
    checks.wrappers = { source: "runtime-module", required: requiredWrappers.length, missing: missingWrappers, ok: missingWrappers.length === 0 };
    if (missingWrappers.length) push({ code: "WRAPPER_UNAVAILABLE", wrappers: missingWrappers, message: `required Supabase wrappers unavailable: ${missingWrappers.join(", ")}` });
  } else if (audit) {
    // The audit already emits SCHEMA_REQUIRED_WRAPPER_MISSING for any absent export, so it is the proof here.
    checks.wrappers = { source: "static-audit", required: audit.requiredWrappers.total, missing: audit.requiredWrappers.missing, ok: audit.requiredWrappers.ok };
  } else {
    checks.wrappers = { source: "none", ok: null, reason: "no wrapper module and no schema-audit reader; wrapper availability is unproven" };
    push({ code: "WRAPPER_AVAILABILITY_UNPROVEN", message: "wrapper availability could not be proven; inject a wrapper module or a schema-audit readFile" });
  }

  // 4 + 5) required tables/RPCs + migration readiness (from the single audit above).
  if (audit) {
    checks.schema = { ok: audit.ok, blockerCount: audit.blockers.length, matrix: audit.matrix, requiredWrappers: audit.requiredWrappers };
    for (const b of audit.blockers) push({ ...sanitizeAuditBlocker(b), code: `SCHEMA_${b.code}` });
  } else {
    checks.schema = { ok: null, reason: "static schema audit reader (readFile) not provided" };
    push({ code: "SCHEMA_AUDIT_UNAVAILABLE", message: "schema contract audit reader was not provided; cannot prove migration readiness" });
  }

  // 6a) v2 readiness ALLOWLIST integrity. The EXPLICIT SCHEDULER_V2_READY_REPORT_KEYS literal must be exactly
  //     13 UNIQUE keys, each an EXISTING controlled report (in CONTROLLED_REPORT_KEYS) with a pinned live
  //     snapshot contract. A duplicate / unknown / missing / non-contract key fails closed with a typed
  //     blocker. Because readiness is an explicit hand-authored literal (NEVER derived from
  //     CONTROLLED_REPORT_KEYS), a future controlled report cannot inherit readiness -- it is simply absent
  //     from this literal until an explicit reviewed edit adds it.
  const readyList = Array.isArray(readyKeys) ? readyKeys : [];
  const readyLiteral = new Set(readyList);
  const controlled = new Set(CONTROLLED_REPORT_KEYS);
  const duplicates = [...new Set(readyList.filter((k, i) => readyList.indexOf(k) !== i))];
  const unknownReady = readyList.filter((k) => !controlled.has(k));
  const missingContract = readyList.filter((k) => !SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[k]);
  const countOk = readyList.length === 13 && readyLiteral.size === 13;
  checks.v2ReadinessAllowlist = { count: readyList.length, unique: readyLiteral.size, duplicates, unknownReady, missingContract, ok: countOk && duplicates.length === 0 && unknownReady.length === 0 && missingContract.length === 0 };
  if (!countOk) push({ code: "V2_READINESS_COUNT", count: readyList.length, unique: readyLiteral.size, message: "the v2 readiness allowlist must be exactly 13 unique report keys" });
  if (duplicates.length) push({ code: "V2_READINESS_DUPLICATE", keys: duplicates, message: "the v2 readiness allowlist contains duplicate keys" });
  if (unknownReady.length) push({ code: "V2_READINESS_UNKNOWN", keys: unknownReady, message: "a v2 readiness key is not a controlled report" });
  if (missingContract.length) push({ code: "V2_READINESS_NO_CONTRACT", keys: missingContract, message: "a v2 readiness key has no live snapshot contract" });

  // 6b) v2 controls. The catalog's READY set must be a SUBSET of the explicit readiness literal (a controlled
  //     report NOT in the literal -- e.g. a future report -- must stay NOT-ready), and nothing may be
  //     scheduled with EMPTY durable settings. This preflight is no-I/O: it cannot read the durable account
  //     rollout / report_sync_settings that gate the live run -- those are verified against production
  //     separately (Appendix W / Appendix Y).
  const catalog = (typeof controlCatalog === "function" ? controlCatalog([]) : []) || [];
  const ready = catalog.filter((c) => c && c.ready).map((c) => c.reportKey);
  const scheduled = catalog.filter((c) => c && c.scheduleEnabled).map((c) => c.reportKey);
  const readyOutsideLiteral = ready.filter((k) => !readyLiteral.has(k));
  checks.v2ControlsLocked = { ready, scheduled, readyOutsideLiteral, ok: readyOutsideLiteral.length === 0 && scheduled.length === 0 };
  if (readyOutsideLiteral.length || scheduled.length) push({ code: "V2_CONTROLS_UNLOCKED", ready: readyOutsideLiteral, scheduled, message: "a Scheduler v2 control is ready OUTSIDE the explicit readiness allowlist, or scheduled with empty durable settings; refusing (fail closed)" });

  return { ready: blockers.length === 0, blockers, checks, expected };
}

// Keep only SAFE, structural fields from an audit blocker (its own codes/messages are already secret-free, but
// this guarantees no unexpected field -- e.g. a future raw string -- ever leaks into preflight telemetry).
function sanitizeAuditBlocker(b) {
  const safe = {};
  for (const k of ["migration", "table", "rpc", "trigger", "wrapper", "columns", "constraints", "expected", "target", "message"]) {
    if (b[k] !== undefined) safe[k] = b[k];
  }
  return safe;
}
