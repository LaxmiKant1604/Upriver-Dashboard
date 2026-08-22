// Scheduler v2 Phase 1c — SHADOW-MODE composition driver.
//
// Wires the pure source worker (source-worker.js) to real Supabase + DataDoe I/O and
// runs the STAGED loop. A brand-new invocation RECONSTRUCTS dependency signals from
// PERSISTED successful source jobs + their saved payloads (and persisted ads rows) — it
// never trusts in-memory-only or browser signals — then plans downstream/fallback jobs
// through the approved Phase 1b resolver.
//
// SHADOW MODE: not imported by any route, cron, or Scheduler v1 (run-sync.js). Nothing
// here runs a live DataDoe probe on import.

import { createExport, pollExport, downloadExport } from "../datadoe.js";
import { organizationFingerprint, sourceJobOwnerId, accountScopeHash } from "../source-identity.js";
import {
  openSyncCycle, claimSyncCycle, getSyncCycle, updateSyncCycleCounts, finalizeSyncCycle,
  upsertSyncSourceJob, getSyncSourceJobs, claimSourceExportAttempt, adoptSourceExportCache,
  recordSyncSourceSuccess, recordSyncSourceFailure, recordSyncSourceExportCreated,
  getSourceExportCache, sourceCacheStorageAdapter, sourceCacheMetadataAdapter,
  upsertSyncSourceJobOwners, getSyncSourceJobOwners, getSyncSourceJobOwnersForCycle, getSyncSourceJobsForOwners, recordSyncSourceJobOwnerStale,
  persistSourceTrancheBudget, reserveSourceExportCreate, getSourceTrancheBudget, getSourceTrancheBudgetHashes,
} from "../supabase.js";
import { REPORT_SOURCE_CONTRACTS } from "./report-source-contracts.js";
import { runSourceJobs } from "./source-worker.js";
import { atomicSaveSourcePayload } from "./source-cache.js";
import { deriveSignalsFromOutcomes, SIGNAL_PRODUCERS, adsCurrencySignal, failedAdsCurrencySignal } from "./source-signals.js";

const SOURCE_CACHE_TTL_MS = 20 * 3600 * 1000;

const VALID_CONNECTION_IDS = new Set(["primary", "dd-secondary"]);

// The connection registry (getDataDoeConnections) speaks its OWN ids -- "primary" | "secondary" --
// but every durable Scheduler-v2 job and this adapter speak the driver ids "primary" | "dd-secondary".
// This is the ONE explicit, server-only boundary that reconciles them, so the registry's "secondary"
// key can actually be selected by a "dd-secondary" job (the bug: makeDataDoeAdapter(getDataDoeConnections())
// indexed a raw "secondary" and could never resolve a "dd-secondary" job). Idempotent: an already-
// normalized "dd-secondary"/"primary" passes through unchanged. Fail closed: an unknown id throws, and
// two connections that normalize to the same driver id are rejected so neither can shadow the other or
// let a job route to the wrong key.
const REGISTRY_TO_DRIVER_CONNECTION_ID = { primary: "primary", secondary: "dd-secondary" };

export function normalizeDataDoeConnections(connections) {
  const normalized = [];
  const seen = new Set();
  for (const conn of connections || []) {
    const rawId = conn && conn.id;
    const id = REGISTRY_TO_DRIVER_CONNECTION_ID[rawId] || (VALID_CONNECTION_IDS.has(rawId) ? rawId : null);
    if (!id) {
      throw new Error(`Cannot normalize DataDoe connection id "${rawId}" to a driver connection id ('primary' | 'dd-secondary').`);
    }
    if (seen.has(id)) {
      throw new Error(`Ambiguous DataDoe connections: two entries normalize to connection id "${id}".`);
    }
    seen.add(id);
    normalized.push({ ...conn, id });
  }
  return normalized;
}

// Turn a resolved job (from reportSourceRequestHashes) into a planned source job that
// carries BOTH the durable identity fields and the in-memory fetch params the live
// adapter needs. fetchParams is NEVER persisted (the DB stores request_meta only).
//
// FAIL CLOSED: connectionId is REQUIRED and explicit ('primary' or 'dd-secondary') — there
// is no silent 'primary' default anywhere in Scheduler v2 — and the resolved job must carry
// a non-empty organizationFingerprint. Both are what the adapter verifies before any call.
//
// OWNER SCOPE (Blocker 4b + senior review gaps 1 & 3): the owner membership's account_scope_hash is the
// INDIVIDUAL account's scope, NEVER the (possibly batched) canonical job scope. It is computed INTERNALLY from
// an authoritative individual `ownerRawSellerId` as accountScopeHash([ownerRawSellerId]) -- a caller-provided
// owner HASH is never accepted. When no rawSellerId is supplied, the legacy fallback to the canonical
// resolved.accountScopeHash is permitted ONLY for a single-account source (0 or 1 seller id, where the
// canonical scope already IS the individual scope); a MULTI-id (batched) source with no authoritative
// rawSellerId FAILS CLOSED rather than collapsing every batch member onto the one shared batch scope.
export function plannedSourceJob(reportKey, resolved, bucket, connectionId, accountId = "", ownerRawSellerId = null, marketplaceConstraint = null, accountTuples = null, ownerMarketplaceCountryCode = null) {
  if (!VALID_CONNECTION_IDS.has(connectionId)) {
    throw new Error(`plannedSourceJob requires an explicit connectionId of 'primary' or 'dd-secondary' (got "${connectionId}").`);
  }
  if (!resolved.organizationFingerprint) {
    throw new Error("plannedSourceJob requires a non-empty organizationFingerprint on the resolved job.");
  }
  const contract = (REPORT_SOURCE_CONTRACTS[reportKey] || []).find((c) => c.requestKey === resolved.requestKey);
  // The durable OWNER membership for this planned source: a deterministic non-secret owner_id over
  // (report family, connection/org boundary, org fingerprint, account scope), plus the report request
  // key as this membership's alias and the SAFE public accountId for admin display. request_key is a
  // membership alias, NOT canonical ownership authority; the canonical job dedups on request_hash.
  //
  // The INDIVIDUAL owner scope. An authoritative rawSellerId is hashed HERE (accountScopeHash([id])); a
  // caller-supplied owner hash is never accepted. Absent one, fall back to the canonical scope ONLY for a
  // single-account source (<=1 seller id) -- a batched source (>1) fails closed.
  const sellerIds = Array.isArray(resolved.sellerOrVendorIds) ? resolved.sellerOrVendorIds : [];
  let ownerScope;
  let ownerRaw; // the INDIVIDUAL raw seller id this owner represents (Blocker 4c: the authoritative
                // accountId -> rawSellerId mapping the derive-time per-account isolation relies on).
  if (ownerRawSellerId != null) {
    const raw = String(ownerRawSellerId);
    if (raw.trim() === "") {
      throw new Error("plannedSourceJob: ownerRawSellerId, when supplied, must be a nonblank individual seller id (fail closed).");
    }
    ownerScope = accountScopeHash([raw]);
    ownerRaw = raw;
  } else if (sellerIds.length <= 1) {
    ownerScope = resolved.accountScopeHash; // single-account source: the canonical scope IS the individual scope
    ownerRaw = sellerIds.length === 1 ? String(sellerIds[0]) : ""; // the one account's seller id (or none)
  } else {
    throw new Error(`plannedSourceJob: a batched source with ${sellerIds.length} seller ids requires an authoritative individual rawSellerId for its owner scope; refusing to fall back to the canonical batch scope (fail closed).`);
  }
  const ownerId = sourceJobOwnerId({
    reportKey, connectionId,
    organizationFingerprint: resolved.organizationFingerprint,
    accountScopeHash: ownerScope,
  });
  if (!ownerId) {
    throw new Error(`plannedSourceJob could not derive an owner_id for report "${reportKey}" (missing connection/organization/account scope).`);
  }
  return {
    requestHash: resolved.requestHash,
    requestKey: resolved.requestKey,
    sourceId: resolved.sourceId,
    sourceKey: resolved.sourceKey,
    connectionId,
    organizationFingerprint: resolved.organizationFingerprint,
    accountScopeHash: resolved.accountScopeHash,   // CANONICAL job scope (the BATCH scope for a batched job)
    requestMeta: resolved.requestMeta,
    bucket: resolved.bucket || bucket,
    strict: resolved.strict === true,
    limit: resolved.limit,
    // Finding 2/3: the DECLARED source scope + whether the contract fetched marketplace_country_code + the
    // batch's canonical marketplace constraint, carried as immutable planned metadata into the source worker's
    // batch validation and the report worker's per-account isolation (both key off the explicit scope).
    sourceScope: resolved.sourceScope,
    marketplaceScoped: resolved.marketplaceScoped === true,
    marketplaceConstraint: marketplaceConstraint == null ? null : String(marketplaceConstraint),
    // EXACT-TUPLE isolation metadata: the batch's authoritative discovered account tuples
    // (rawSellerId, marketplaceCountryCode) -- carried immutably so the source worker validates every downloaded
    // batch row against the exact (seller, marketplace) PAIRS (never two independent sets), and so a marketplace-
    // blind source can still detect a rawSellerId that maps to >1 marketplace account (AMBIGUOUS_ACCOUNT_EVIDENCE).
    // null for a single-account (non-batched) source. A non-US family carries mixed marketplaces here WITHOUT
    // splitting the batch (one export over all non-US marketplaces).
    accountTuples: Array.isArray(accountTuples) && accountTuples.length ? accountTuples.map((t) => ({ rawSellerId: String(t.rawSellerId ?? ""), marketplaceCountryCode: t.marketplaceCountryCode == null ? null : String(t.marketplaceCountryCode) })) : null,
    // owner.accountScopeHash is the INDIVIDUAL account scope (never the batch scope) -- one exact report/account.
    // owner.rawSellerId is that account's authoritative individual seller id; owner.marketplaceCountryCode is that
    // account's exact marketplace (the derive-time per-account isolation of a marketplace-scoped source keys off
    // it). owner carries the COMPLETE metadata (Finding 1) the derive-time per-account isolation requires.
    owner: { ownerId, requestKey: resolved.requestKey, reportKey, accountId: String(accountId || ""), rawSellerId: ownerRaw, marketplaceCountryCode: ownerMarketplaceCountryCode == null ? null : String(ownerMarketplaceCountryCode), connectionId, organizationFingerprint: resolved.organizationFingerprint, accountScopeHash: ownerScope },
    fetchParams: {
      // Report-contract columns when the reportKey names a declared report; otherwise the RESOLVED request's
      // own columns (the source-first bucket sync plans canonical source requests under a synthetic
      // "source-sync" owner family, whose specs are built directly from the same canonical constants --
      // request_hash equality with the report contracts is proven by test). Report paths are byte-identical
      // (their contract always exists).
      columns: contract ? contract.columns : resolved.columns,
      sellerOrVendorIds: resolved.sellerOrVendorIds,
      from: resolved.from,
      to: resolved.to,
      limit: resolved.limit,
      options: resolved.options,
    },
  };
}

// Build the planned source jobs for ONE batched canonical source (Blocker 4b + senior review gaps 1 & 2):
// the SAME canonical job (one request_hash over the sorted batch seller ids) with ONE owner membership PER
// account, each carrying that account's INDIVIDUAL owner scope + SAFE public accountId, so all accounts own
// the single shared export without owner-id collisions. DataDoe permits ANY number of seller ids in one export,
// so there is NO per-batch account cap. `resolvedBatch` is the batch's resolved source (batch request_hash +
// batch account_scope_hash over sellerOrVendorIds).
//
// `batchAccounts` is the AUTHORITATIVE account-record list `[{ accountId, rawSellerId, country? }]` -- a SAFE
// public accountId, that account's INDIVIDUAL raw seller id, and (when known) its marketplace country. The
// individual owner scope is computed INTERNALLY (accountScopeHash([rawSellerId]) inside plannedSourceJob); a
// caller-provided owner HASH is NEVER accepted (gap 1).
//
// FAIL CLOSED before ANY source/owner upsert (gap 2): the batch account set must EXACTLY equal
// resolvedBatch.sellerOrVendorIds -- every rawSellerId nonblank, the accounts unique (any number), covering
// exactly the canonical batch sellers (no missing, no extra), on a valid connection with a non-empty
// organization fingerprint, and with the resolvedBatch's own canonical scope equal to
// accountScopeHash(sellerOrVendorIds). Any mismatch THROWS, so no partial/mis-owned plan is ever returned.
//
// Finding 3: `marketplaceCountry` is the batch's SINGLE canonical marketplace constraint (a batch never mixes
// marketplaces). When the resolved batch fetched marketplace_country_code it is REQUIRED (fail closed) and is
// carried into every job's immutable metadata for the source worker to validate every downloaded row against.
export function plannedBatchSourceJobs(reportKey, resolvedBatch, bucket, connectionId, batchAccounts, marketplaceCountry = null) {
  if (!VALID_CONNECTION_IDS.has(connectionId)) {
    throw new Error(`plannedBatchSourceJobs requires an explicit connectionId of 'primary' or 'dd-secondary' (got "${connectionId}").`);
  }
  if (!resolvedBatch || !resolvedBatch.organizationFingerprint) {
    throw new Error("plannedBatchSourceJobs requires a non-empty organizationFingerprint on the resolved batch (fail closed).");
  }
  if (resolvedBatch.marketplaceScoped === true && (marketplaceCountry == null || String(marketplaceCountry).trim() === "")) {
    throw new Error("plannedBatchSourceJobs: a marketplace-scoped seller batch requires a single canonical marketplaceCountry constraint (fail closed).");
  }
  const accounts = Array.isArray(batchAccounts) ? batchAccounts : [];
  if (accounts.length === 0) {
    throw new Error("plannedBatchSourceJobs requires a non-empty batchAccounts list (fail closed).");
  }
  // No per-batch account cap: DataDoe permits any number of sellerOrVendorIds in one export. [Superseded: the
  // former <=5-account reject.] The account set must still EXACTLY equal resolvedBatch.sellerOrVendorIds below.
  // Each authoritative record must carry a nonblank public accountId AND a nonblank individual rawSellerId.
  const accountIds = [];
  const rawSellerIds = [];
  for (const a of accounts) {
    const accountId = a && typeof a.accountId === "string" ? a.accountId : "";
    const rawSellerId = a && typeof a.rawSellerId === "string" ? a.rawSellerId : "";
    if (accountId.trim() === "") {
      throw new Error("plannedBatchSourceJobs: every batch account requires a nonblank public accountId (fail closed).");
    }
    if (rawSellerId.trim() === "") {
      throw new Error("plannedBatchSourceJobs: every batch account requires a nonblank rawSellerId (fail closed).");
    }
    accountIds.push(accountId);
    rawSellerIds.push(rawSellerId);
  }
  if (new Set(rawSellerIds).size !== rawSellerIds.length) {
    throw new Error("plannedBatchSourceJobs: duplicate rawSellerId across batch accounts; refusing (fail closed).");
  }
  if (new Set(accountIds).size !== accountIds.length) {
    throw new Error("plannedBatchSourceJobs: duplicate accountId across batch accounts; refusing (fail closed).");
  }
  // The batch account set must EXACTLY equal the canonical batch sellers (no missing, no extra). The canonical
  // scope must also be accountScopeHash(those sellers) -- otherwise the owner memberships would not correspond
  // to the export this shared job actually fetches.
  const canonicalIds = (Array.isArray(resolvedBatch.sellerOrVendorIds) ? resolvedBatch.sellerOrVendorIds : []).map((x) => String(x == null ? "" : x));
  if (canonicalIds.length === 0 || canonicalIds.some((x) => x.trim() === "")) {
    throw new Error("plannedBatchSourceJobs: resolvedBatch.sellerOrVendorIds must be a non-empty list of nonblank seller ids (fail closed).");
  }
  if (new Set(canonicalIds).size !== canonicalIds.length) {
    throw new Error("plannedBatchSourceJobs: resolvedBatch.sellerOrVendorIds contains duplicate seller ids (fail closed).");
  }
  const want = new Set(canonicalIds);
  const got = new Set(rawSellerIds.map((x) => String(x)));
  const missing = [...want].filter((x) => !got.has(x));
  const extra = [...got].filter((x) => !want.has(x));
  if (missing.length || extra.length) {
    throw new Error(`plannedBatchSourceJobs: the batch account set does not equal resolvedBatch.sellerOrVendorIds (missing: [${missing.join(", ")}], extra: [${extra.join(", ")}]); refusing (fail closed).`);
  }
  if (accountScopeHash(canonicalIds) !== resolvedBatch.accountScopeHash) {
    throw new Error("plannedBatchSourceJobs: resolvedBatch.accountScopeHash does not equal accountScopeHash(sellerOrVendorIds); refusing (fail closed).");
  }
  // The batch's authoritative EXACT account tuples (rawSellerId, marketplaceCountryCode). An account's
  // marketplace is its directory `country` (a batch account IS one marketplace); absent evidence stays null
  // (seller-only isolation, allowed only when the seller maps to exactly one account). A non-US family mixes
  // marketplaces here WITHOUT splitting the single batch. Carried onto every job + its owner for exact-tuple
  // save-time validation and derive-time per-account isolation.
  const tupleMkt = (a) => {
    const m = a.marketplaceCountryCode ?? a.country ?? marketplaceCountry;
    return m == null ? null : String(m);
  };
  const accountTuples = accounts.map((a) => ({ rawSellerId: String(a.rawSellerId), marketplaceCountryCode: tupleMkt(a) }));
  const marketplaceOf = new Map(accountTuples.map((t) => [t.rawSellerId, t.marketplaceCountryCode]));
  return accounts.map((a) => plannedSourceJob(reportKey, resolvedBatch, bucket, connectionId, a.accountId, a.rawSellerId, marketplaceCountry, accountTuples, marketplaceOf.get(String(a.rawSellerId))));
}

// Production store: maps the worker's injected interface to lib/server/supabase.js.
// Round-6 blocker 1: an OPTIONAL route-owned deadline binds EVERY production Supabase/Storage read+write
// this store performs. When present, each method is checked-before-request and raced against the remaining
// budget (deadline.bound), and the deadline's AbortSignal reaches the real HTTP wrapper so an in-flight
// fetch genuinely aborts; a timed-out WRITE surfaces the typed ROUTE_DEADLINE_EXCEEDED with commitUnknown
// (never claimed uncommitted). When `deadline` is null (the dispatcher, Scheduler v1, every non-route
// caller) each method calls its wrapper EXACTLY as before -- no signal, no timer, byte-identical behaviour.
export function makeSupabaseSourceStore({ deadline = null } = {}) {
  const sig = deadline ? deadline.signal : null;
  const storage = sourceCacheStorageAdapter({ signal: sig });
  const metadata = sourceCacheMetadataAdapter({ signal: sig });
  // Bind one store operation. `write` chooses the typed in-flight expiry semantics (commitUnknown for a
  // write). With no deadline the op is invoked with a null signal -> identical to the pre-round-6 call.
  const w = (phase, write, fn) => (deadline ? deadline.bound(`store:${phase}`, (signal) => fn(signal), { write }) : fn(null));
  const r = (phase, fn) => w(phase, false, fn);
  return {
    openCycle: (args) => w("open-cycle", true, (signal) => openSyncCycle(args, { signal })),
    claimCycle: (cycleId) => w("claim-cycle", true, (signal) => claimSyncCycle(cycleId, { signal })),
    getCycle: (cycleId, opts) => r("get-cycle", (signal) => getSyncCycle(cycleId, { signal, ...(opts || {}) })),
    upsertSourceJob: (job) => w("upsert-source-job", true, (signal) => upsertSyncSourceJob(job, { signal })),
    listSourceJobs: (cycleId) => r("list-source-jobs", (signal) => getSyncSourceJobs(cycleId, { signal })),
    // Many-to-many owner memberships (sync_source_job_owners) -- canonical jobs stay one row/export.
    upsertSourceJobOwners: (memberships) => w("upsert-owners", true, (signal) => upsertSyncSourceJobOwners(memberships, { signal })),
    listSourceJobOwners: (cycleId, ownerIds) => r("list-owners", (signal) => getSyncSourceJobOwners(cycleId, ownerIds, { signal })),
    // Round-6 fix 5: EVERY owner membership of the cycle -- the authoritative account<->hash ownership the
    // source-first report lineage builds ACCOUNT-EXACT depends_on from.
    listCycleOwners: (cycleId, opts) => r("list-cycle-owners", (signal) => getSyncSourceJobOwnersForCycle(cycleId, { signal, ...(opts || {}) })),
    listSourceJobsForOwners: (cycleId, ownerIds) => r("list-jobs-for-owners", (signal) => getSyncSourceJobsForOwners(cycleId, ownerIds, { signal })),
    recordSourceOwnerStale: (args) => w("owner-stale", true, (signal) => recordSyncSourceJobOwnerStale(args, { signal })),
    claimExportAttempt: (cycleId, requestHash) => w("claim-export", true, (signal) => claimSourceExportAttempt(cycleId, requestHash, { signal })),
    // Blocker 2: the atomic cache-adoption CAS (adopt_source_export_cache), returning a typed
    // 'adopted' | 'not-adopted' acknowledgement. Mutually exclusive with claimExportAttempt.
    adoptSourceCache: (args) => w("adopt-cache", true, (signal) => adoptSourceExportCache(args, { signal })),
    recordExportCreated: (args) => w("export-created", true, (signal) => recordSyncSourceExportCreated(args, { signal })),
    loadSourceRows: (requestHash) => r("load-source-rows", (signal) => getSourceExportCache(requestHash, { signal })),
    // The immutable-object storage save + pointer switch is already commit-unknown-safe by construction (a
    // dropped/aborted pointer write NEVER deletes the new object; LKG is preserved). The deadline binds the
    // whole save so an aborted in-flight save surfaces the typed WRITE expiry (commitUnknown) too. The
    // adapters carry the deadline's signal, so their fetches abort genuinely.
    saveSourceRows: ({ job, rows, payloadBytes, version }) => w("save-source-rows", true, () => atomicSaveSourcePayload({
      storage, metadata,
      requestHash: job.request_hash ?? job.requestHash,
      sourceId: job.source_id ?? job.sourceId,
      organizationFingerprint: job.organization_fingerprint ?? job.organizationFingerprint ?? "",
      accountScopeHash: job.account_scope_hash ?? job.accountScopeHash ?? "",
      requestMeta: job.request_meta ?? job.requestMeta ?? {},
      rows, payloadBytes,
      expiresAt: new Date(Date.now() + SOURCE_CACHE_TTL_MS).toISOString(),
      version,
    })),
    recordSourceSuccess: (args) => w("source-success", true, (signal) => recordSyncSourceSuccess(args, { signal })),
    recordSourceFailure: (args) => w("source-failure", true, (signal) => recordSyncSourceFailure(args, { signal })),
    updateCycleCounts: (cycleId, counts) => w("cycle-counts", true, (signal) => updateSyncCycleCounts(cycleId, counts, { signal })),
    // Blocker 4d wiring: the FROZEN per-(cycle, tranche) create/AI-token budget. persistBudget freezes the
    // reviewed plan ceilings once ('created' | 'exists'; drift RAISES PLAN_BUDGET_MISMATCH with no mutation);
    // reserveExportCreate is the ATOMIC pre-POST reservation the source worker uses whenever a budget context
    // is active -- only a 'reserved' acknowledgement may POST a create-export. The read pair feeds the
    // source-status surface (spent vs ceiling). All four are inert unless a budget-aware composition calls them.
    persistBudget: (args) => w("persist-budget", true, (signal) => persistSourceTrancheBudget(args, { signal })),
    reserveExportCreate: (args) => w("reserve-export", true, (signal) => reserveSourceExportCreate(args, { signal })),
    getBudget: (args) => r("get-budget", (signal) => getSourceTrancheBudget(args, { signal })),
    getBudgetHashes: (args) => r("get-budget-hashes", (signal) => getSourceTrancheBudgetHashes(args, { signal })),
    // Dispatcher-owned cycle finalization (Blocker 1): the guarded finalize_sync_cycle RPC, returning a typed
    // disposition. The canonical dispatcher calls this on a complete drained SCHEDULED scope; a source-family
    // driver never calls it.
    finalizeCycle: ({ cycleId }) => w("finalize-cycle", true, (signal) => finalizeSyncCycle(cycleId, { signal })),
  };
}

// Production DataDoe adapter with FAIL-CLOSED organization routing. A source job may run
// ONLY on the connection that owns it: connection_id must be an explicit, valid id, and
// the job's organizationFingerprint must match that connection's key. Missing / unknown /
// mismatched routing throws BEFORE any DataDoe call — an unresolved secondary job is never
// silently sent to the primary key. The apiKey is used here and never returned or stored.
export function makeDataDoeAdapter(connections) {
  // Normalize registry ids ("primary" | "secondary") onto the driver ids the jobs carry
  // ("primary" | "dd-secondary") at this single boundary, so makeDataDoeAdapter(getDataDoeConnections())
  // routes a "dd-secondary" job to the SECONDARY key (never a silent primary fallback).
  const byId = new Map(normalizeDataDoeConnections(connections).map((c) => [c.id, c]));
  function resolveConnection(job) {
    const id = job.connection_id ?? job.connectionId;
    if (id !== "primary" && id !== "dd-secondary") {
      throw new Error(`Source job has a missing/invalid connection id "${id}".`);
    }
    const conn = byId.get(id);
    if (!conn || !conn.apiKey) throw new Error(`No configured DataDoe connection for "${id}".`);
    const expected = conn.organizationFingerprint || organizationFingerprint(conn.apiKey);
    const jobFingerprint = job.organizationFingerprint ?? job.organization_fingerprint;
    // Unconditional: a missing fingerprint is a hard failure, and it must match the
    // selected connection. A secondary job can never be routed to the primary key.
    if (!jobFingerprint) {
      throw new Error(`Source job for connection "${id}" is missing its organization fingerprint.`);
    }
    if (jobFingerprint !== expected) {
      throw new Error(`Source job organization does not match connection "${id}"; refusing to route it.`);
    }
    return conn;
  }
  return {
    create: async (job) => {
      const conn = resolveConnection(job); // throws before createExport
      const p = job.fetchParams;
      if (!p || !p.columns) throw new Error("Planned source job is missing its fetch parameters.");
      const created = await createExport(conn.apiKey, job.sourceId ?? job.source_id, p.columns, p.sellerOrVendorIds, p.from, p.to, p.limit, p.options || {});
      return { exportId: created.exportId || created.id, completed: created.status === "COMPLETED" };
    },
    poll: async (job, exportId) => { const conn = resolveConnection(job); await pollExport(conn.apiKey, exportId); },
    download: async (job, exportId) => { const conn = resolveConnection(job); return downloadExport(conn.apiKey, exportId); },
  };
}

/**
 * Reconstruct the typed signals a brand-new worker process needs from PERSISTED state:
 * the kickoff plan gives the signal-producing request keys -> hashes; for each whose DB
 * job SUCCEEDED, the saved payload is loaded and the signal re-derived. A failed /
 * terminal / not-yet-successful primary contributes no activating signal. PPC ads currency
 * comes from persisted ads rows (never a live export). No browser/UI input is trusted.
 */
export async function reconstructSignals({ store, cycleId, resolvePlan, adsRowsProvider }) {
  const signals = {};
  const kickoff = await resolvePlan({});
  const producers = (kickoff.sourceJobs || []).filter((j) => SIGNAL_PRODUCERS[j.requestKey]);
  const jobs = await store.listSourceJobs(cycleId);
  const byHash = new Map(jobs.map((j) => [j.request_hash ?? j.requestHash, j]));
  for (const p of producers) {
    const jobRow = byHash.get(p.requestHash);
    const status = jobRow && (jobRow.fetch_status ?? jobRow.fetchStatus);
    if (status !== "succeeded") continue; // only a validated saved success can activate downstream

    // Distinguish a genuine empty success from missing/corrupt cached data. ONLY a payload
    // that LOADS cleanly with an array `rows` (possibly []) is a validated success. A cache
    // miss, a read error, or a payload whose `rows` is not an array is UNAVAILABLE — it must
    // NOT be reconstructed as validated:true, or a missing SQP payload could wrongly activate
    // catalog / monthly-fallback work.
    let rows = null;
    try {
      const payload = store.loadSourceRows ? await store.loadSourceRows(p.requestHash) : null;
      if (payload && Array.isArray(payload.rows)) rows = payload.rows;
    } catch (_readError) {
      rows = null;
    }
    if (rows === null) {
      // Persisted job says succeeded, but its cached payload is missing/unreadable/malformed:
      // a safe source-cache-unavailable state that activates NOTHING downstream.
      signals[p.requestKey] = SIGNAL_PRODUCERS[p.requestKey]({ requestKey: p.requestKey, status: "failed", validated: false, unavailableReason: "source-cache-unavailable" });
      continue;
    }
    signals[p.requestKey] = SIGNAL_PRODUCERS[p.requestKey]({ requestKey: p.requestKey, status: "success", validated: true, rows });
  }
  if (adsRowsProvider) {
    // A validated currency read requires a real array of persisted ads rows. A missing/failed
    // read must NOT present as currencyCount 0 (which would schedule total-sales); it is
    // unavailable, so total-sales stays unscheduled (fail closed).
    let adsRows = null;
    try { adsRows = await adsRowsProvider(); } catch (_e) { adsRows = null; }
    signals["ppc-performance:ads-currency"] = Array.isArray(adsRows)
      ? adsCurrencySignal(adsRows)
      : failedAdsCurrencySignal();
  }
  return signals;
}

/**
 * Run (or resume) ONE cycle end to end in staged rounds. Reconstructs signals from
 * persisted state first (so a fresh invocation plans downstream without repeating a
 * primary export), then: plan -> execute -> derive fresh signals -> re-plan -> execute,
 * bounded by maxRounds, maxJobs, and the wall-clock deadline. Never exposes a secret.
 */
export async function runStagedSourceCycle({
  store, dataDoe, resolvePlan, adsRowsProvider, extraSignals = {},
  bucket, cycleDate, scheduledAt = null, trigger = "manual",
  clock = () => Date.now(), deadlineMs = Infinity, reserveMs = 3_000, maxJobs = Infinity, maxRounds = 5,
  // BUILD-TIME source-tranche selector (Part A); passed straight to runSourceJobs. A filtered pass never
  // drains, so it never reaches the fixpoint below -- no owner membership is reconciled mid-tranche.
  sourceTranche = null,
  // BUILD-TIME reuseOnly rehearsal flag (Blocker 3); passed straight to runSourceJobs.
  reuseOnly = false,
  // Blocker 4d: the FROZEN tranche budget context { trancheKey, planFingerprint } (persisted BEFORE this
  // invocation); passed straight to runSourceJobs so every create goes through the atomic pre-POST
  // reservation. null => the legacy one-attempt claim (behavior byte-identical). NEVER a per-run caller arg.
  budget = null,
}) {
  const cycleId = await store.openCycle({ bucket, cycleDate, scheduledAt, trigger });
  let signals = { ...(await reconstructSignals({ store, cycleId, resolvePlan, adsRowsProvider })), ...extraSignals };

  const rollup = {
    cycleId, rounds: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0, deferred: 0,
    deadlineReached: false, drained: false, signals,
  };
  const seenHashes = new Set();
  // This generic staged driver declares its OWN owner memberships (sync_source_job_owners) so it can
  // share the single (bucket, cycle_date) cycle with other report families (e.g. Keyword Rank) without
  // touching their canonical jobs. owner_id (sourceJobOwnerId) is account/organization safe; the declared
  // owner set + the planned membership keys grow as each round's plan (kickoff + reconstructed/derived
  // fallbacks) reveals more of this driver's jobs. runSourceJobs processes only THIS driver's owned+
  // planned canonical jobs; a job owned by another family is never touched.
  const ownerIdSet = new Set();
  const plannedMembershipKeys = new Set(); // owner_id|request_hash actually planned this invocation
  // Blocker 1: stale reconciliation is safe ONLY when the plan is fully resolved -- i.e. the driver
  // reached its FIXPOINT (a round added no new hashes and derived no new signals). A bounded (maxJobs/
  // maxRounds), deadline-stopped, or otherwise-truncated invocation has an INCOMPLETE authoritative plan,
  // so it must NOT retire memberships it merely did not stage yet. `fixpointReached` gates reconciliation.
  let fixpointReached = false;

  for (let round = 0; round < maxRounds; round += 1) {
    const plan = await resolvePlan(signals);
    const plannedJobs = (plan && plan.sourceJobs) || [];
    for (const j of plannedJobs) {
      if (j && j.owner && j.owner.ownerId) { ownerIdSet.add(j.owner.ownerId); plannedMembershipKeys.add(`${j.owner.ownerId}|${j.requestHash}`); }
    }
    const remaining = maxJobs === Infinity ? Infinity : Math.max(0, maxJobs - rollup.processed);
    if (remaining === 0) { rollup.drained = false; break; }

    const res = await runSourceJobs({
      store, dataDoe, plannedJobs, ownerIds: [...ownerIdSet], bucket, cycleDate, scheduledAt, trigger,
      clock, deadlineMs, reserveMs, maxJobs: remaining, sourceTranche, reuseOnly, budget,
    });
    rollup.cycleId = res.cycleId;
    rollup.rounds = round + 1;
    rollup.processed += res.processed;
    rollup.succeeded += res.succeeded;
    rollup.failed += res.failed;
    rollup.skipped += res.skipped;
    rollup.deferred += res.deferred || 0;
    rollup.counts = res.counts;

    const before = JSON.stringify(signals);
    signals = { ...signals, ...deriveSignalsFromOutcomes(res.outcomes) };
    rollup.signals = signals;

    if (res.deadlineReached) { rollup.deadlineReached = true; rollup.drained = false; break; }
    // Blocker 1: a resumable poll/download deferral adds NO dependency signal, so on a later round the same
    // hashes are already `allSeen` and signals are unchanged -- which would falsely look like a fixpoint even
    // though the plan is NOT complete (a source is mid-fetch and `res.drained` is false). Stop immediately on
    // ANY deferral (as Keyword Rank does), leave drained=false, and NEVER reconcile: a fresh invocation
    // resumes the export from its persisted export_id, and reconciliation waits for a genuine fixpoint.
    if ((res.deferred || 0) > 0) { rollup.drained = false; break; }

    const planHashes = plannedJobs.map((j) => j.requestHash);
    const allSeen = planHashes.every((h) => seenHashes.has(h));
    planHashes.forEach((h) => seenHashes.add(h));
    if (allSeen && JSON.stringify(signals) === before) {
      // A VALID fixpoint additionally requires a genuinely DRAINED (and, by the guards above, non-deadline,
      // non-deferred) result -- otherwise the plan is stable but unfinished and must NOT be reconciled.
      rollup.drained = res.drained;
      fixpointReached = res.drained === true;
      break;
    }
    rollup.drained = res.drained;
  }
  // Reconcile ONLY when the plan fully resolved (fixpoint reached): the accumulated planned membership
  // keys are then the COMPLETE authoritative dependency set, so a genuinely removed dependency goes stale
  // while nothing merely-not-yet-staged is retired. A truncated invocation defers reconciliation.
  if (fixpointReached) {
    await reconcileStaleOwnerMemberships(store, rollup.cycleId, [...ownerIdSet], plannedMembershipKeys);
  }
  return rollup;
}

// Mark any DURABLE active owner membership (for the declared owners) that this invocation's plan no longer
// contains as stale -- owner-scoped only. It NEVER touches the shared canonical sync_source_jobs row or
// any other owner's membership, and never triggers a DataDoe call: a hash another owner still depends on
// stays executable/resumable/readable, and its last-known-good source data remains valid.
export async function reconcileStaleOwnerMemberships(store, cycleId, ownerIds, plannedMembershipKeys) {
  if (!cycleId || !store.listSourceJobOwners || !store.recordSourceOwnerStale || !ownerIds.length) return;
  const durable = await store.listSourceJobOwners(cycleId, ownerIds);
  for (const m of durable) {
    const ownerId = m.owner_id ?? m.ownerId;
    const requestHash = m.request_hash ?? m.requestHash;
    const status = m.owner_status ?? m.ownerStatus ?? "active";
    if (status === "stale") continue;
    if (!plannedMembershipKeys.has(`${ownerId}|${requestHash}`)) {
      await store.recordSourceOwnerStale({ cycleId, requestHash, ownerId, code: "STALE_PLAN", message: "Owner plan no longer requires this source; membership retired (canonical source preserved)." });
    }
  }
}
