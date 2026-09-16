// Scheduler v2 -- US / NON-US BUCKET SOURCE SYNC (Phase 4; offline-composable, ZERO ambient I/O).
//
// ONE operator action per marketplace bucket ("all non-US accounts" / "all US accounts") = ONE orchestration
// run -- NEVER one unlimited DataDoe POST. Internally:
//   - every export covers AT MOST five compatible accounts (the stable batch engine; assignAccountBatches
//     preserves existing membership, so a newly discovered account joins a non-full batch or a fresh one and
//     NOTHING reshuffles);
//   - each export is scoped to EXACTLY the batch members sharing a contiguous MISSING window (planOliSliceExports,
//     complete-window -- no 7-day pre-slicing) and to at most MAX_OLI_EXPORT_WINDOW_DAYS (441) inclusive days,
//     splitting a longer missing window into contiguous <=cap chunks: the steady-state RESTORED rolling refresh
//     is one small batch export over the trailing 7-day window, the initial backfill is the complete window in
//     <=cap chunks, a new account backfills SOLO, and completed accounts are never re-exported;
//   - the organization-wide durable catalog refreshes ONCE per organization per day (its request identity is
//     bucket-free, so the second bucket adopts the first bucket's durable cache with zero DataDoe);
//   - the FBA inventory snapshot refreshes once daily per account (latest-VALIDATED preserved on failure);
//   - families run ONE AT A TIME in canonical order (OLI -> catalog -> FBA) over the shared
//     (bucket, cycle_date) cycle with the full plan upserted before narrowing, frozen create/token ceilings
//     per (cycle, family), a completion-anchored cooldown (injected clock/waiter -- never sleeps here), and
//     a REQUIRED-source failure stopping this bucket (the other bucket runs independently);
//   - a PAUSED source (source_controls) plans ZERO new exports while durable history / coverage / snapshots /
//     LKG stay untouched.
//
// HASH IDENTITY: the OLI slice requests are built from the SAME canonical fragment spec the five OLI reports
// declare (read from REPORT_SOURCE_CONTRACTS), over canonicalOliSlices -- so a durable backfill slice carries
// the EXACT request_hash daily-reporting / fba-plan / buy-box-loss / returns-leakage / ppc-performance
// resolve, and one export feeds every owner (proven by test). Golden hashes unchanged.

import { sourceRequestIdentity } from "../source-identity.js";
import { sourceContractForKey } from "../source-contracts.js";
import { addDaysStr } from "../date-windows.js";
import { REPORT_SOURCE_CONTRACTS, sourceScopeForContract } from "./report-source-contracts.js";
import { assignAccountBatches, MAX_ACCOUNTS_PER_BATCH } from "./source-batching.js";
import { isRoutingScope } from "./scheduler-scope.js";
import { plannedSourceJob, plannedBatchSourceJobs } from "./source-sync-driver.js";
import { runSourceJobs } from "./source-worker.js";
import { READINESS_INCOMPLETE_CODE } from "./source-readiness-isolation.js";
import { makeSourceTranche } from "./source-tranche.js";
import { computeFrozenTrancheBudget } from "./source-tranche-budget.js";
import { registryIsPremiumOf, sourceRegistryEntry } from "./source-registry.js";
import {
  oliBackfillWindow, oliRollingRefreshWindow, planOliSliceExports,
  oliHistoryRowsFromFragment, oliDimensionalRowsFromFragment, snapshotRefreshDecision, catalogSnapshotScope, ORGANIZATION_SCOPE_KEY,
  OLI_SOURCE_KEY, CATALOG_SOURCE_KEY, FBA_INVENTORY_SOURCE_KEY,
} from "./source-durable-model.js";
import { buildBrandMaps } from "./brand-resolution.js";

// The synthetic OWNER report family for source-first jobs. Owner memberships stay per-ACCOUNT (each batch
// member is an individual owner); the report_key marks source-first ownership -- it is NOT a dashboard, is
// never readiness-gated, and never publishes anything. When a real report later plans the same canonical
// request_hash it simply adds ITS membership to the same canonical row (the proven multi-owner model).
export const SOURCE_SYNC_OWNER_REPORT_KEY = "source-sync";
export const DURABLE_CATALOG_REQUEST_KEY = "source-catalog:durable-v1";
export const OLI_SLICE_REQUEST_KEY = "source-oli:slice-v1";
export const FBA_SNAPSHOT_REQUEST_KEY = "source-fba:snapshot-v1";

// The durable organization-wide catalog request. Product Catalog 68d2de238e is organization-wide and does NOT
// support a `sku` column (DataDoe rejects it with HTTP 400), so the durable catalog fetches ONLY the four
// supported columns; the SKU->brand fallback is derived from durable OLI history (SKU->child_asin) joined to
// this catalog's child_asin->brand map, never from an unproven catalog `sku` field.
export const DURABLE_CATALOG_COLUMNS = Object.freeze(["child_asin", "parent_asin", "product_name", "product_brand"]);
// DataDoe rejects create-export limits above 5,000. The catalog currently returns fewer rows, so this
// preserves the complete organization-wide payload while keeping the request inside the live API contract.
export const DURABLE_CATALOG_ROW_LIMIT = 5000;

// Deterministically select ONE Catalog carrier seller from the FULL fresh primary directory (the full `active`
// classification, NOT one bucket). Product Catalog is organization-wide -- one syntactically-required seller id
// does not filter the org-wide result -- but the id must be a canonical, nonblank PRIMARY seller (never a
// dd-secondary / prefixed id), and it MUST be identical for US and Non-US so both buckets produce ONE canonical
// request hash / one reservation / one create. The choice is internal + deterministic (sorted, first); it is
// NEVER taken from HTTP/CLI/runtime input. Returns the carrier id, or null when no canonical primary exists
// (the catalog planner then fails closed BEFORE any reservation/create).
export function selectCatalogCarrierSeller(activeAccounts) {
  const ids = [];
  for (const a of Array.isArray(activeAccounts) ? activeAccounts : []) {
    const accountId = String((a && (a.accountId ?? a.id)) || "").trim();
    if (!accountId || accountId.includes(":")) continue; // primary only; a prefixed dd-secondary id is excluded
    ids.push(accountId); // for primary accounts rawSellerId === accountId (a canonical DataDoe seller id)
  }
  const canonical = [...new Set(ids)].sort();
  return canonical.length ? canonical[0] : null;
}

// FBA inventory is EXACTLY the single snapshot day [asOf .. asOf] (D-1) -- mirrors fba-plan:inventory-health.

const isDateStr = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

function contractOf(reportKey, requestKey) {
  const c = (REPORT_SOURCE_CONTRACTS[reportKey] || []).find((x) => x.requestKey === requestKey);
  if (!c) throw new Error(`source-bucket-sync: canonical contract "${requestKey}" is missing from "${reportKey}" (fail closed).`);
  return c;
}

function optionsOf(c) {
  return {
    groupBy: c.groupBy || undefined,
    aggregations: c.aggregations || undefined,
    orderByColumn: c.orderByColumn,
    orderByDirection: c.orderByDirection,
  };
}

// The canonical OLI slice request for ONE member-subset unit -- byte-identical identity to the five OLI
// reports' shared fragment over the same slice/scope (proven by test).
export function resolvedOliSliceBatch({ apiKey, unit, bucket }) {
  const c = contractOf("daily-reporting", "daily-reporting:oli-sales");
  const sourceId = sourceContractForKey(OLI_SOURCE_KEY).ids[0];
  const options = optionsOf(c);
  const identity = sourceRequestIdentity({
    apiKey, sourceId, columns: c.columns, ids: unit.sellerOrVendorIds,
    from: unit.slice.from, to: unit.slice.to, limit: c.limit, options,
  });
  return {
    ...identity,
    requestKey: OLI_SLICE_REQUEST_KEY,
    sourceId, sourceKey: OLI_SOURCE_KEY,
    bucket, strict: true, limit: c.limit,
    sourceScope: sourceScopeForContract(c), // "seller" (the allowlisted batched fragment)
    marketplaceScoped: false,
    sellerOrVendorIds: [...unit.sellerOrVendorIds],
    columns: c.columns,
    from: unit.slice.from, to: unit.slice.to, options,
  };
}

// The durable org-wide catalog request (once per organization; bucket-free identity). Product Catalog
// 68d2de238e is organization-wide: DataDoe REQUIRES a nonblank sellerOrVendorIds (one carrier seller does NOT
// filter the org-wide result) but REJECTS an empty array, a from/to date range, or an unsupported `sku` column
// with HTTP 400. So the request carries exactly ONE deterministic carrier seller (identical for both buckets),
// NO from/to (the catalog is a current snapshot), and only the four supported columns. The carrier seller id is
// bound into the canonical request hash (via accountScopeHash), so US + Non-US share ONE hash / owner /
// reservation / create. A missing/blank/noncanonical carrier fails closed BEFORE any reservation or create.
export function resolvedDurableCatalog({ apiKey, carrierSellerId, bucket }) {
  const carrier = String(carrierSellerId == null ? "" : carrierSellerId).trim();
  if (!carrier || carrier.includes(":")) throw new Error("resolvedDurableCatalog requires a canonical primary carrier seller id (fail closed).");
  const sourceId = sourceContractForKey(CATALOG_SOURCE_KEY).ids[0];
  const options = { orderByColumn: "child_asin", orderByDirection: "ASC" };
  const identity = sourceRequestIdentity({
    apiKey, sourceId, columns: [...DURABLE_CATALOG_COLUMNS], ids: [carrier],
    from: null, to: null, limit: DURABLE_CATALOG_ROW_LIMIT, options,
  });
  return {
    ...identity,
    requestKey: DURABLE_CATALOG_REQUEST_KEY,
    sourceId, sourceKey: CATALOG_SOURCE_KEY,
    bucket, strict: true, limit: DURABLE_CATALOG_ROW_LIMIT,
    sourceScope: "organization", marketplaceScoped: false,
    sellerOrVendorIds: [carrier],
    columns: [...DURABLE_CATALOG_COLUMNS],
    from: null, to: null, options,
  };
}

// The per-account FBA inventory snapshot request (same canonical spec as fba-plan:inventory-health, so the
// hash is SHARED with the fba-plan report when both cover the same account/asOf). Finding 10: the data IS
// seller-scoped (the rows belong to this one seller) and the contract fetches marketplace_country_code, so
// the resolved job carries the honest scope + the account's marketplace constraint; every downloaded row is
// additionally validated against that marketplace before any snapshot is recorded (validateFbaSnapshotRows).
export function resolvedFbaSnapshot({ apiKey, account, asOf, bucket }) {
  if (!isDateStr(asOf)) throw new Error("resolvedFbaSnapshot requires a YYYY-MM-DD asOf (fail closed).");
  if (!String(account.country || "").trim()) {
    throw new Error("resolvedFbaSnapshot requires the account's marketplace country for row validation (fail closed).");
  }
  const c = contractOf("fba-plan", "fba-plan:inventory-health");
  const sourceId = sourceContractForKey(FBA_INVENTORY_SOURCE_KEY).ids[0];
  const options = optionsOf(c);
  const identity = sourceRequestIdentity({
    apiKey, sourceId, columns: c.columns, ids: [account.rawSellerId],
    from: asOf, to: asOf, limit: c.limit, options,
  });
  return {
    ...identity,
    requestKey: FBA_SNAPSHOT_REQUEST_KEY,
    sourceId, sourceKey: FBA_INVENTORY_SOURCE_KEY,
    bucket, strict: true, limit: c.limit,
    sourceScope: "seller",
    marketplaceScoped: true,
    marketplaceCountry: String(account.country),
    sellerOrVendorIds: [String(account.rawSellerId)],
    columns: c.columns,
    from: asOf, to: asOf, options,
  };
}

// Finding 10: validate EVERY returned FBA row against the account's marketplace BEFORE any snapshot is
// recorded. The single-account fetch bypasses the worker's >1-id batch validation, so this is the
// persistence-side gate: every non-empty row must be a plain object carrying the account's exact
// marketplace_country_code (blank/mismatched/malformed rows reject the WHOLE payload -- latest-good
// preserved). A zero-row payload is valid empty evidence.
export function validateFbaSnapshotRows(rows, marketplaceCountry) {
  if (!Array.isArray(rows)) return { valid: false, code: "MALFORMED_PAYLOAD" };
  const want = String(marketplaceCountry || "").trim();
  if (!want) return { valid: false, code: "MARKETPLACE_CONSTRAINT_MISSING" };
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return { valid: false, code: "MALFORMED_PAYLOAD" };
    const nonEmpty = Object.values(row).some((v) => v != null && String(v).trim() !== "");
    if (!nonEmpty) continue;
    const got = String(row.marketplace_country_code ?? "").trim();
    if (!got) return { valid: false, code: "FBA_ROW_NO_MARKETPLACE" };
    if (got !== want) return { valid: false, code: "FBA_CROSS_MARKETPLACE" };
  }
  return { valid: true, code: null };
}

// Clip proven coverage so the rolling refresh window is ALWAYS re-exported (its slices upsert idempotently;
// late Amazon corrections replace matching rows). Coverage before the refresh window stays proven.
export function clipCoverageForRefresh(windows, refreshFrom) {
  const clipped = [];
  for (const w of windows || []) {
    if (w.from >= refreshFrom) continue; // wholly inside the refresh window: re-export
    clipped.push({ from: w.from, to: w.to < refreshFrom ? w.to : addDaysStr(refreshFrom, -1) });
  }
  return clipped;
}

/**
 * PLAN one bucket's source sync (pure; zero I/O). Inputs are all injected evidence:
 *   accounts            : [{ accountId, rawSellerId }] -- this bucket's discovered accounts;
 *   existingMembership  : Map(accountId -> batchIndex) -- the durable stable membership (never reshuffled);
 *   coverageByAccountId : accountId -> proven OLI windows;
 *   catalogSnapshot     : { validated_at } | null -- the org's durable catalog snapshot;
 *   fbaSnapshotsByAccount: accountId -> { validated_at } | undefined;
 *   pausedSources       : Set(sourceKey) -- paused families plan ZERO new exports;
 *   asOf / today        : YYYY-MM-DD (marketplace-local latest completed day / decision day).
 * Returns { batches, membership, families:[{sourceKey, plannedJobs, units?}], skippedPaused, summary }.
 */
// Apply readiness ISOLATION to a source's stable <=5-seller batches (pure). Each isolate member (a seller whose
// newest readiness event is a DATADOE_INITIAL_LOAD_INCOMPLETE rejection) is PEELED OFF into its own single-seller
// batch so it 400s ALONE (a typed waiting no-op that self-clears when it next succeeds); the HEALTHY remainder stays
// BATCHED (never poisoned, and no wasted single-seller exports). Empty set => the input batches unchanged
// (byte-identical). Peel-off (vs whole-batch split) is what lets a continuation reproduce the frozen plan exactly
// from the durable owners: a single-owner OLI hash <=> a peeled seller; the batched remainder keeps its hash.
function readinessAdjustedBatches(batches, isolateSet) {
  if (!isolateSet || isolateSet.size === 0) return batches;
  const raw = (a) => String((a && (a.rawSellerId ?? a.sellerId)) || "");
  const out = [];
  for (const batch of batches) {
    const members = batch.accounts || [];
    const isolated = members.filter((a) => isolateSet.has(raw(a)));
    if (isolated.length === 0) { out.push(batch); continue; }
    for (const a of isolated) out.push({ accounts: [a] });         // peel each unready seller to its own single-seller batch
    const rest = members.filter((a) => !isolateSet.has(raw(a)));
    if (rest.length) out.push({ accounts: rest });                 // the healthy remainder stays batched (efficient, unpoisoned)
  }
  return out;
}

export function planBucketSourceSync({
  apiKey, bucket, accounts, existingMembership = new Map(),
  coverageByAccountId = {}, catalogSnapshot = null, fbaSnapshotsByAccount = {},
  pausedSources = new Set(), asOf, today,
  // The deterministic organization Catalog carrier seller (selectCatalogCarrierSeller over the FULL fresh
  // primary directory; identical for both buckets). REQUIRED whenever a Catalog job is planned -- the org-wide
  // Product Catalog request must carry exactly one canonical primary seller id (empty => DataDoe HTTP 400).
  catalogCarrierSeller = null,
  // PRIORITY DASHBOARDS PATH: force the organization Catalog family to plan a job even when its snapshot is
  // already fresh-today. The Daily Reporting + Brand View priority derive runs ONLY after a drained cycle
  // (globalDrained), and its lineage binds to a cycle Catalog hash; forcing the (cache-reusing, zero-token
  // when warm) Catalog job gives that path a drainable cycle without any OLI/Ads/FBA fetch.
  forceCatalogRefresh = false,
  // READINESS ISOLATION (batch-poisoning self-heal). A Set of RAW seller ids whose newest readiness event is a
  // DATADOE_INITIAL_LOAD_INCOMPLETE rejection (source-readiness-isolation.js), passed ONLY on a FRESH cycle (never a
  // frozen continuation -- the frozen plan is reproduced verbatim). The OLI batch containing such a seller is split
  // into single-seller jobs so the healthy members succeed independently and the unready one 400s alone (a typed
  // waiting no-op that self-clears on its next success). Empty set => byte-identical to the prior plan.
  readinessIsolateSellers = new Set(),
  // ADAPTIVE ROW-CAP SELF-HEAL. A Set of RAW seller ids PROVEN to truncate their day-bounded OLI backfill chunk at the
  // 5,000-row create cap (prior-cycle terminal TRUNCATED source-oli:slice-v1 evidence, resolved to raw ids by the
  // runtime). planOliSliceExports re-slices ONLY these sellers' missing windows by the canonical weekly bins (row-cap
  // safe) so a dense account's history fills instead of truncating forever; every other seller keeps the efficient
  // <=cap chunking. The evidence is prior-cycle + terminal (stable across a cycle), so re-deriving it on a continuation
  // reproduces the same plan -- NO frozen state (unlike readinessIsolateSellers, whose events can drift mid-cycle).
  // Empty set => byte-identical to the historical OLI plan.
  oliBackfillWeeklySellers = new Set(),
} = {}) {
  if (!isRoutingScope(bucket)) throw new Error(`planBucketSourceSync requires a routing scope (india|europe-au|us-ca|us|non-us; got "${bucket}").`);
  if (!Array.isArray(accounts) || accounts.length === 0) throw new Error("planBucketSourceSync requires this bucket's non-empty account list (fail closed).");
  if (!isDateStr(asOf) || !isDateStr(today)) throw new Error("planBucketSourceSync requires YYYY-MM-DD asOf + today (fail closed).");
  for (const a of accounts) {
    if (!a || !String(a.accountId || "").trim() || !String(a.rawSellerId || "").trim()) {
      throw new Error("planBucketSourceSync: every account requires accountId + rawSellerId (fail closed).");
    }
  }

  // 1) STABLE <=5-account batches; existing membership preserved, new accounts join without reshuffling.
  // Batching is over the FULL account set so persisted membership is never disturbed by a transient readiness flip.
  const { membership, batches } = assignAccountBatches(accounts, existingMembership, MAX_ACCOUNTS_PER_BATCH);

  // Normalize the readiness isolate set (accept a Set or an array). Empty => byte-identical to the prior behavior.
  const isolateSet = readinessIsolateSellers instanceof Set ? readinessIsolateSellers : new Set(readinessIsolateSellers || []);
  const rawOf = (a) => String((a && (a.rawSellerId ?? a.sellerId)) || "");
  const readinessIsolated = isolateSet.size ? accounts.filter((a) => isolateSet.has(rawOf(a))).map((a) => String(a.accountId)) : [];

  const families = [];
  const skippedPaused = [];

  // 2) OLI: complete-window exports scoped to the batch members sharing a contiguous MISSING window. The
  //    trailing rolling-refresh window is always re-exported (idempotent replace); completed history is not.
  if (pausedSources.has(OLI_SOURCE_KEY)) {
    skippedPaused.push(OLI_SOURCE_KEY);
  } else {
    const backfill = oliBackfillWindow(asOf);
    const refresh = oliRollingRefreshWindow(asOf);
    const oliJobs = [];
    const allUnits = [];
    // COMPLETE-WINDOW authorized backfill (no 7-day pre-slicing). Each member's coverage is first CLIPPED to
    // exclude the trailing rolling-refresh window (registry incrementalRefresh, 7 days -- RESTORED, not removed),
    // so DataDoe's restatement of the last few days is always re-pulled (idempotent replace-matching-rows) while
    // genuinely proven older history is NEVER re-exported. planOliSliceExports then emits ONE export per
    // contiguous missing window (SEPARATED coverage gaps => SEPARATE exports, never merged into one), each split
    // into contiguous chunks of at most MAX_OLI_EXPORT_WINDOW_DAYS: steady state re-fetches only the trailing
    // 7-day window (one cache-hit-stable export/batch); an initial backfill fetches the whole window in <=cap
    // chunks. An empty authorized window (asOf before the fixed start) skips OLI.
    if (backfill.from <= backfill.to) {
      // READINESS ISOLATION applies to OLI (a seller-batched Seller-Central source): split a batch holding an
      // isolate member into single-seller units so the healthy members are never poisoned by the unready one.
      for (const batch of readinessAdjustedBatches(batches, isolateSet)) {
        const members = batch.accounts;
        const clippedCoverage = Object.fromEntries(members.map((a) => [
          a.accountId, clipCoverageForRefresh(coverageByAccountId[a.accountId] || [], refresh.from),
        ]));
        const units = planOliSliceExports({ batchAccounts: members, coverageByAccountId: clippedCoverage, from: backfill.from, to: backfill.to, weeklySliceSellers: oliBackfillWeeklySellers });
        for (const unit of units) {
          const resolved = resolvedOliSliceBatch({ apiKey, unit, bucket });
          oliJobs.push(...plannedBatchSourceJobs(SOURCE_SYNC_OWNER_REPORT_KEY, resolved, bucket, "primary", unit.accounts, null));
          allUnits.push({ ...unit, requestHash: resolved.requestHash });
        }
      }
    }
    families.push({ sourceKey: OLI_SOURCE_KEY, plannedJobs: oliJobs, units: allUnits });
  }

  // 3) CATALOG: once per ORGANIZATION per day (never per dashboard or per seller).
  if (pausedSources.has(CATALOG_SOURCE_KEY)) {
    skippedPaused.push(CATALOG_SOURCE_KEY);
  } else {
    const decision = snapshotRefreshDecision({ sourceKey: CATALOG_SOURCE_KEY, lastValidatedAt: catalogSnapshot && catalogSnapshot.validated_at, today });
    const catalogJobs = [];
    if (decision.refresh || forceCatalogRefresh) {
      // resolvedDurableCatalog fails closed on a missing/blank/noncanonical carrier -- BEFORE any reservation
      // or create -- so a Catalog can never be planned without its one canonical primary carrier seller.
      const resolved = resolvedDurableCatalog({ apiKey, carrierSellerId: catalogCarrierSeller, bucket });
      catalogJobs.push(plannedSourceJob(SOURCE_SYNC_OWNER_REPORT_KEY, resolved, bucket, "primary", ORGANIZATION_SCOPE_KEY));
    }
    families.push({ sourceKey: CATALOG_SOURCE_KEY, plannedJobs: catalogJobs, decision, forcedRefresh: !decision.refresh && forceCatalogRefresh });
  }

  // 4) FBA INVENTORY: once daily per account; historical inventory is never repeatedly backfilled. The
  //    planned job carries the account's marketplace constraint (finding 10) so persistence can validate
  //    every returned row against it.
  if (pausedSources.has(FBA_INVENTORY_SOURCE_KEY)) {
    skippedPaused.push(FBA_INVENTORY_SOURCE_KEY);
  } else {
    const fbaJobs = [];
    for (const account of accounts) {
      const snap = fbaSnapshotsByAccount[account.accountId];
      const decision = snapshotRefreshDecision({ sourceKey: FBA_INVENTORY_SOURCE_KEY, lastValidatedAt: snap && snap.validated_at, today });
      if (!decision.refresh) continue;
      const resolved = resolvedFbaSnapshot({ apiKey, account, asOf, bucket });
      fbaJobs.push(plannedSourceJob(SOURCE_SYNC_OWNER_REPORT_KEY, resolved, bucket, "primary", account.accountId, account.rawSellerId, resolved.marketplaceCountry));
    }
    families.push({ sourceKey: FBA_INVENTORY_SOURCE_KEY, plannedJobs: fbaJobs });
  }

  const summary = {
    accounts: accounts.length,
    batches: batches.length,
    plannedJobsByFamily: Object.fromEntries(families.map((f) => [f.sourceKey, f.plannedJobs.length])),
    // Honest readiness accounting (req 7): sellers routed into single-seller isolation this cycle (the unready one
    // becomes a typed "waiting"/"Setting up" no-op with LKG preserved). Empty when no readiness set was supplied.
    readinessIsolatedAccounts: readinessIsolated,
  };
  return { batches, membership, families, skippedPaused, summary };
}

// Round-4 finding 5: EVERY persistence-time payload problem -- an UNREADABLE loader (throws), a MISSING
// entry, a MALFORMED (non-array) payload, or a DOMAIN-INVALID one (catalog with no usable brands; FBA rows
// failing marketplace validation) -- is the SAME typed fail-closed stop: the bucket stops non-drained,
// durable persistence is never silently skipped, and LKG stays intact.
async function loadPayloadOrNull(store, requestHash) {
  if (!store.loadSourceRows) return null;
  try { return await store.loadSourceRows(requestHash); } catch (_e) { return null; }
}

const OPEN = new Set(["pending", "attempted"]);
const stat = (r) => r.fetch_status ?? r.fetchStatus ?? "pending";
const skey = (r) => r.source_key ?? r.sourceKey ?? "";

async function familyState(store, cycleId, sourceKey) {
  const state = { total: 0, open: 0, succeeded: 0, failed: 0, readinessWaiting: 0, deferredPending: 0 };
  if (!cycleId) return state;
  for (const r of await store.listSourceJobs(cycleId)) {
    if (skey(r) !== sourceKey) continue;
    state.total += 1;
    const s = stat(r);
    if (OPEN.has(s)) state.open += 1;
    else if (s === "succeeded") state.succeeded += 1;
    else if (s === "failed") {
      state.failed += 1;
      const ec = String(r.error_code ?? r.errorCode ?? "");
      // A terminal DATADOE_INITIAL_LOAD_INCOMPLETE is a typed "waiting"/"Setting up" deferral (the seller's Seller
      // Central initial load is incomplete), NOT a required-source failure: it must NOT stop the bucket and block the
      // HEALTHY accounts from deriving/publishing. It self-heals via the next fresh cycle's single-seller isolation
      // (multi-member) then exclusion (single-member). The cycle still finalizes honestly PARTIAL (a failed job
      // exists), so the region is never reported all-fresh (no false-green).
      if ((r.terminal ?? false) === true && ec === READINESS_INCOMPLETE_CODE) state.readinessWaiting += 1;
      // A SOURCE_READINESS_PENDING job is the ZERO-EXPORT reconciler's no-export refusal (the durable source is not
      // adoptable this pass; source-worker classifyFetchError). Like readinessWaiting it is a RETRYABLE deferral, not a
      // required-source failure -- it must not hard-stop the bucket. Emitted ONLY on the reconciler path (the real
      // DataDoe adapter never produces it), so this counter is always 0 for the scheduled full-region cycle.
      else if (ec === "SOURCE_READINESS_PENDING") state.deferredPending += 1;
    }
  }
  return state;
}

// P0-2: the typed fail-closed result when a continuation's durable frozen scope cannot be established (owners
// unreadable / malformed). ZERO jobs, budgets, reservations, and DataDoe POSTs; LKG preserved; the cycle is left
// resumable (continuationRequired) so a later pass can retry once the frozen scope is readable again.
function deferredFrozenScope(bucket, cycleId, reason, { deferredReason = "deferred-frozen-scope-unavailable", detail = null } = {}) {
  return {
    bucket, cycleId: cycleId || null, plan: null, skippedPaused: [], families: [],
    stopped: true, stopReason: Object.freeze({ code: "FROZEN_SCOPE_UNAVAILABLE", reason, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) }),
    globalDrained: false, deadlineReached: false, continuationRequired: true,
    deferred: true, deferredReason,
    history: { rowsPersisted: 0, accountsCovered: 0 }, snapshots: { recorded: [], rejected: [] },
  };
}

const safeMessage = (e) => String(e && e.message ? e.message : e || "").slice(0, 200);
// The three source-sync families whose frozen tranche budgets a continuation may resume (planBucketSourceSync order).
const CONTINUATION_FAMILIES = Object.freeze([OLI_SOURCE_KEY, CATALOG_SOURCE_KEY, FBA_INVENTORY_SOURCE_KEY]);
const rowHash = (r) => String((r && (r.request_hash ?? r.requestHash)) ?? "").trim();

/**
 * RUN one bucket's source sync end to end (the ONE operator action). Collaborators are all injected --
 * store + dataDoe (the proven worker backends), durable-model sinks (persistHistory / recordCoverage /
 * persistSnapshot / updateRunStatus -- production: the supabase.js wrappers), clock + wait (cooldown;
 * NEVER sleeps here), reuseOnly (rehearsal: zero creates + tripwire upstream). Families run one at a time
 * (OLI -> catalog -> FBA) over ONE shared (bucket, cycleDate) cycle: the FULL bucket plan is upserted every
 * pass while execution narrows to the family (the engine's proven tranche mechanics); ceilings are frozen
 * per (cycle, "source-sync:<family>") BEFORE the family's first create; a REQUIRED-source failure stops
 * this bucket (later families never launch; durable data + LKG preserved).
 */
export async function runBucketSourceSync({
  apiKey, bucket, accounts, existingMembership = new Map(),
  coverageByAccountId = {}, catalogSnapshot = null, fbaSnapshotsByAccount = {},
  pausedSources = new Set(), asOf, today,
  store, dataDoe,
  replaceHistoryWindow = null, persistSnapshot = null, updateRunStatus = null, recordCompleteness = null,
  cycleDate, scheduledAt = null, trigger = "manual",
  // OPTIONAL cycle-bucket NAMESPACE (defaults to `bucket`, so the scheduler-v2 daily path is byte-identical).
  // A dedicated operator (FBA Plan; the bootstrap publication) passes e.g. "bootstrap-india" so ITS
  // sync_cycles row never collides with the scheduler-v2 daily (bucket, cycle_date) cycle. ONLY the cycle
  // key is namespaced; account scope + every source request identity stays the real `bucket`.
  cycleBucket = null,
  clock = () => Date.now(), wait = null, cooldownMs = 60_000,
  // Finding 3: the serverless execution budget. deadlineMs/reserveMs thread into every runSourceJobs pass
  // AND gate the family loop itself, so one bounded invocation stops with a RESUMABLE typed rollup
  // (continuationRequired) instead of being killed mid-flight; a fresh invocation re-enters the same
  // (bucket, cycle_date) cycle with no duplicate create.
  deadlineMs = Infinity, reserveMs = 3_000,
  maxContinuationsPerFamily = 6, reuseOnly = false, budgets = true,
  // The deterministic organization Catalog carrier seller (threaded into planBucketSourceSync -> the org-wide
  // Catalog request). REQUIRED whenever a Catalog job is planned.
  catalogCarrierSeller = null,
  // PRIORITY DASHBOARDS PATH: force a Catalog job so a catalog-only (OLI/Ads/FBA-paused) run still drains a
  // cycle for the durable-evidence Daily Reporting + Brand View derive. See planBucketSourceSync.
  forceCatalogRefresh = false,
  // FORCE-FRESH-OLI (previous-day "force latest"): a pending OLI job skips the stale-cache adoption so it makes a
  // real create-export POST (re-querying DataDoe for newly-settled D-1 rows). Threaded to runSourceJobs.
  forceFreshOli = false,
  // READINESS ISOLATION set (raw seller ids) resolved from durable DATADOE_INITIAL_LOAD_INCOMPLETE evidence. The
  // caller composition resolves it; it is threaded into planBucketSourceSync ONLY on a FRESH cycle (a frozen
  // continuation must reproduce its frozen plan verbatim, so the set is dropped there). Empty => byte-identical.
  readinessIsolateSellers = new Set(),
  // ADAPTIVE ROW-CAP SELF-HEAL: RAW seller ids whose OLI backfill chunk PROVED to truncate the 5,000-row create cap
  // (prior-cycle terminal TRUNCATED source-oli:slice-v1 evidence, resolved to raw ids by the runtime). Threaded into
  // planBucketSourceSync on BOTH fresh + continuation: the evidence is prior-cycle + terminal (stable across the cycle),
  // so re-deriving it reproduces the same weekly-sliced plan on a continuation with NO frozen state -- unlike
  // readinessIsolateSellers. Empty => byte-identical to the historical plan (efficient <=cap chunking for every seller).
  oliBackfillWeeklySellers = new Set(),
  // EXECUTION-READINESS DEFER (all-region scheduler repair): primary account ids proven DataDoe-NOT-READY by the
  // export-eligibility gate (initialLoadComplete=false / not onboarded). On a FRESH cycle they are DEFERRED from the
  // plan ENTIRELY (no create -- a multi-seller OLI export containing an unloaded seller is 400'd by the provider,
  // poisoning healthy batch-mates), so the plan equals the gated eligible set. Discovery still LISTS them (the
  // frozen-owner safety check compares frozen owners against full discovery -- gating discovery would omit a
  // now-unready frozen owner and defer the whole continuation). A CONTINUATION is UNTOUCHED: it reproduces its frozen
  // membership from durable owners verbatim (a frozen owner that went unready post-freeze is handled by the reactive
  // readiness isolation / retry, never dropped here). Empty => byte-identical to the prior behavior.
  preemptiveUnreadyAccountIds = new Set(),
  // AUTHORIZED FRESH-PLAN ACCOUNT SET (all-region scheduler repair, req 2): the EXPLICIT, POSITIVELY-authorized set of
  // primary account ids a FRESH cycle may plan -- the export-eligibility gate's `eligible` accounts (full mode) or the
  // immutable approved dispatch wave (bootstrap mode). When supplied (non-null), the FRESH plan is the INTERSECTION
  // discovery INTER allowlist, so an account present in current discovery but ABSENT from the authorized set (a
  // brand-new account that appeared between the gate read and discovery, or a bootstrap account outside the approved
  // wave) can NEVER enter the plan or issue a create -- it joins a LATER wave only after it is itself gated/authorized.
  // This is the POSITIVE control the exclusion list alone cannot provide (Codex req 2). Discovery (`accounts`) is still
  // FULL, so the frozen-owner safety check sees every owner. A CONTINUATION is untouched (frozen membership). null =>
  // no allowlist (byte-identical; the non-gated FBA/materialize/priority callers pass none). Accepts a Set or array.
  freshPlanAccountIds = null,
  // P0-A COMPLETE-DAILY-PLAN: when set (a Set of source keys), FREEZE every planned family's tranche budget + upsert
  // its canonical jobs/owners, but CREATE/DRAIN only the families in this set THIS step. Freeze-only families are
  // reordered BEFORE the executed ones so their budgets are committed BEFORE the first paid create ("one complete
  // daily-cycle plan before the first paid create"), and left OPEN on the cycle for a later step (the priority step
  // drains the frozen Catalog as a case-(a) continuation). null => execute every planned family (byte-identical).
  executeSourceKeys = null,
} = {}) {
  if (!store || typeof store.listSourceJobs !== "function") throw new Error("runBucketSourceSync requires the injected store (fail closed).");
  if (Number(cooldownMs) > 0 && typeof wait !== "function") {
    throw new Error("runBucketSourceSync: a positive cooldown requires an injected wait(ms) collaborator (fail closed).");
  }
  const outOfTime = () => deadlineMs !== Infinity && clock() >= deadlineMs - reserveMs;

  const nowIso = () => new Date(clock()).toISOString();

  // Head-aware ACTIVE cycle resolution, ONCE for the whole run (BEFORE planning so a continuation can plan from the
  // frozen membership): when a running/pending head already exists for the slot -- a base cycle in progress OR a
  // superseding attempt an operator created to take over a stale terminal slot -- every write in this run (the
  // frozen budget persist AND the source jobs) MUST target THAT cycle, so the budget and the create-reservation
  // share one cycle_id. Resolved to null when no active head exists (a fresh BASE cycle is opened on the first
  // write). A missing getCycleByBucketDate capability (test doubles) keeps the old base path.
  const cycleKeyBucket = cycleBucket || bucket;
  let activeCycleId = null;
  if (typeof store.getCycleByBucketDate === "function") {
    let head = null;
    try { head = await store.getCycleByBucketDate(cycleKeyBucket, cycleDate); }
    catch (e) {
      // A cycle-read ERROR is NEVER proof of a fresh cycle: opening/planning on top of an unknown active head could
      // duplicate exports or drift a frozen budget. Defer typed (zero jobs/budgets/reservations/POSTs; LKG; resumable).
      return deferredFrozenScope(bucket, null, "cycle-read-failed", { deferredReason: "deferred-cycle-unreadable", detail: safeMessage(e) });
    }
    if (head && head.id && ["running", "pending"].includes(String(head.status))) activeCycleId = head.id;
  }

  // P0-2 STRICT FROZEN-CYCLE CONTINUATION: an active running/pending cycle is ALWAYS a continuation, and its
  // membership + budget come ONLY from the durable frozen owners/budgets -- NEVER from current discovery. On a
  // continuation this code:
  //   (a) scopes the plan to the frozen per-account membership (the accounts whose owners were persisted at freeze)
  //       when it intersects discovery, so post-freeze accounts are excluded and existing batches never rehash;
  //   (b) in the family loop below, REUSES each family's persisted frozen budget verbatim (never recompute/persist
  //       from current discovery -> no PLAN_BUDGET_MISMATCH) and SKIPS any family without a frozen budget (that is
  //       new/unfrozen work -> it joins the NEXT fresh cycle);
  //   (c) if the frozen owners cannot be READ, or are present but all malformed, FAILS CLOSED with a typed
  //       `deferred-frozen-scope-unavailable` result: zero jobs, zero budgets, zero reservations, zero DataDoe POSTs,
  //       LKG preserved, the cycle left resumable.
  // A continuation requires BOTH durable readers (listCycleOwners + getBudget); a store lacking them (offline test
  // double) is not strict-continuation-capable and takes the fresh idempotent path (a same-membership re-persist is a
  // no-op "exists"). A fresh cycle (no active head) always plans from discovery.
  // STRICT CONTINUATION RESOLUTION (round 2): an active cycle is resumed ONLY from durable evidence --
  //   * the PRODUCTION readers are REQUIRED (listCycleOwners + getBudget + getBudgetHashes + listSourceJobs); a store
  //     lacking any of them cannot prove the frozen scope and DEFERS (never the fresh path on an active cycle);
  //   * EMPTY owners, ANY blank/malformed owner identity, a frozen per-account owner ABSENT from current discovery
  //     (partial intersection), an indeterminate organization-only cycle, an UNREADABLE budget/hash read, or a
  //     malformed frozen budget all DEFER typed BEFORE any mutation (zero jobs/budgets/reservations/POSTs; LKG);
  //   * membership is EXACTLY the frozen per-account owner set (never widened/narrowed by discovery); a NEW account
  //     joins the NEXT fresh cycle;
  //   * an organization-only (catalog) cycle is recognised ONLY from POSITIVE persisted evidence (org owners + every
  //     persisted job is the catalog family) and NEVER admits current per-account discovery work;
  //   * the continuation PLAN is restricted to the PERSISTED job/request identities that are ALSO in the family's
  //     frozen budget hashes -- matching account ids alone freezes nothing (dates/coverage/batches/hashes are bound by
  //     the persisted identities); a plan that cannot REPRODUCE an open frozen job defers (never a different plan);
  //   * a family with NO frozen budget row (successful read, null) on a cycle with a known per-account frozen
  //     membership is REQUIRED work that a bounded earlier invocation had not yet frozen (families freeze one at a
  //     time): it is frozen NOW from the FROZEN membership (never from current discovery) and executed on the same
  //     cycle -- never silently skipped. On an organization-only cycle no per-account membership exists, so per-account
  //     families are skipped (joins the next fresh cycle). Both are distinct from a FAILED budget read, which defers.
  let planningAccounts = accounts;
  let isContinuation = false;
  let continuation = null;
  if (budgets && activeCycleId) {
    const readersMissing = ["listCycleOwners", "getBudget", "getBudgetHashes", "listSourceJobs"].filter((k) => typeof store[k] !== "function");
    if (readersMissing.length) return deferredFrozenScope(bucket, activeCycleId, "continuation-readers-unavailable", { detail: readersMissing.join(",") });
    let owners = null;
    try { owners = await store.listCycleOwners(activeCycleId); } catch (e) { return deferredFrozenScope(bucket, activeCycleId, "owner-read-failed", { detail: safeMessage(e) }); }
    if (!Array.isArray(owners)) return deferredFrozenScope(bucket, activeCycleId, "owner-read-failed", { detail: "non-array owner read" });
    if (owners.length === 0) {
      // FRESH-ON-ACTIVE (P0-B enabler): a freshly-opened active head with NO owners is EITHER a base/superseding
      // attempt an operator just opened (open_superseding_sync_cycle inserts an empty 'pending' row) OR an earlier
      // invocation that opened the cycle + froze a budget but crashed BEFORE upserting any canonical job/owner. It has
      // NO reproducible frozen plan (owners ARE the frozen membership), so it is NOT a continuation. When it ALSO has
      // zero persisted CANONICAL JOBS it is genuinely UNPOPULATED (nothing was executed or reserved): take the FRESH
      // plan on THIS cycle (writes target activeCycleId). Re-planning duplicates NOTHING -- openCycle is idempotent,
      // persist_source_tranche_budget is idempotent for the same deterministic same-day plan ('exists') and raises
      // PLAN_BUDGET_MISMATCH (fail closed, no mutation) for a drifted one, and the create-reservation is atomic. This
      // is what lets a freshly-SUPERSEDED cycle actually get planned + fetched instead of deferring forever, and also
      // recovers the (astronomically rare) freeze-then-crash-before-upsert window. Any PERSISTED CANONICAL JOB without
      // owners is indeterminate (a job could already be succeeded/spent, and a fresh re-plan under drifted discovery
      // might orphan it and double-fetch) -> defer typed (fail closed; LKG preserved).
      let jobs0 = null;
      try { jobs0 = await store.listSourceJobs(activeCycleId); } catch (e) { return deferredFrozenScope(bucket, activeCycleId, "job-read-failed", { detail: safeMessage(e) }); }
      if (!Array.isArray(jobs0)) return deferredFrozenScope(bucket, activeCycleId, "job-read-failed", { detail: "non-array job read" });
      if (jobs0.length !== 0) return deferredFrozenScope(bucket, activeCycleId, "frozen-owners-empty");
      // else: genuinely unpopulated -> fall through as a FRESH cycle (isContinuation stays false; writes -> activeCycleId).
    } else {
      isContinuation = true;
      const ownerIdsRaw = owners.map((o) => String((o && (o.account_id ?? o.accountId)) ?? "").trim());
      const blank = ownerIdsRaw.filter((id) => !id).length;
      if (blank > 0) return deferredFrozenScope(bucket, activeCycleId, "owner-identities-malformed", { detail: `${blank} of ${ownerIdsRaw.length} owner identities blank` });
      const perAccountOwnerIds = new Set(ownerIdsRaw.filter((id) => id !== ORGANIZATION_SCOPE_KEY));
      let persistedJobs = null;
      try { persistedJobs = await store.listSourceJobs(activeCycleId); } catch (e) { return deferredFrozenScope(bucket, activeCycleId, "job-read-failed", { detail: safeMessage(e) }); }
      if (!Array.isArray(persistedJobs)) return deferredFrozenScope(bucket, activeCycleId, "job-read-failed", { detail: "non-array job read" });
      const persistedHashes = new Set(persistedJobs.map(rowHash).filter(Boolean));
      let orgOnly = false;
      if (perAccountOwnerIds.size === 0) {
        const orgEvidence = persistedJobs.length > 0 && persistedJobs.every((r) => skey(r) === CATALOG_SOURCE_KEY);
        if (!orgEvidence) return deferredFrozenScope(bucket, activeCycleId, "frozen-scope-indeterminate", { detail: "organization-only owners without positive persisted catalog job evidence" });
        orgOnly = true;
      } else {
        const byId = new Map((accounts || []).map((a) => [String((a && (a.accountId ?? a.id)) || "").trim(), a]));
        const missing = [...perAccountOwnerIds].filter((id) => !byId.has(id));
        if (missing.length) return deferredFrozenScope(bucket, activeCycleId, "frozen-accounts-missing", { detail: `${missing.length} of ${perAccountOwnerIds.size} frozen account(s) absent from current discovery` });
        planningAccounts = [...perAccountOwnerIds].map((id) => byId.get(id));
      }
      const frozenByFamily = new Map();
      for (const sourceKey of CONTINUATION_FAMILIES) {
        const trancheKey = `source-sync:${sourceKey}`;
        let row = null;
        try { row = await store.getBudget({ cycleId: activeCycleId, trancheKey }); } catch (e) { return deferredFrozenScope(bucket, activeCycleId, "budget-read-failed", { detail: sourceKey + ": " + safeMessage(e) }); }
        if (!row) { frozenByFamily.set(sourceKey, null); continue; } // genuinely unplanned family (successful read)
        if (!String(row.plan_fingerprint ?? row.planFingerprint ?? "").trim()) return deferredFrozenScope(bucket, activeCycleId, "frozen-budget-malformed", { detail: sourceKey + ": blank plan fingerprint" });
        let hashRows = null;
        try { hashRows = await store.getBudgetHashes({ cycleId: activeCycleId, trancheKey }); } catch (e) { return deferredFrozenScope(bucket, activeCycleId, "budget-read-failed", { detail: sourceKey + " hashes: " + safeMessage(e) }); }
        const hashes = new Set((Array.isArray(hashRows) ? hashRows : []).map(rowHash).filter(Boolean));
        if (hashes.size === 0) return deferredFrozenScope(bucket, activeCycleId, "frozen-budget-malformed", { detail: sourceKey + ": no frozen request hashes" });
        frozenByFamily.set(sourceKey, { trancheKey, planFingerprint: String(row.plan_fingerprint ?? row.planFingerprint), hashes });
      }
      // Reproduce the frozen READINESS split on this continuation from the DURABLE owners (never re-resolved evidence,
      // which could drift mid-cycle). An OLI slice request_hash owned by EXACTLY ONE account was a single-seller
      // isolation (peel-off) at freeze; deriving the isolate set from those single-owner OLI hashes makes
      // planBucketSourceSync reproduce the EXACT frozen single-seller plan, so a split cycle that spans multiple
      // serverless invocations RESUMES instead of deferring (a whole batch that was NOT split keeps its multi-owner
      // hash and is untouched). Byte-identical for a cycle that was never split (no single-owner OLI hash).
      const oliCountByHash = new Map();
      const oliAcctByHash = new Map();
      for (const o of owners) {
        if (String((o && (o.request_key ?? o.requestKey)) || "") !== OLI_SLICE_REQUEST_KEY) continue;
        const h = String((o && (o.request_hash ?? o.requestHash)) || "");
        if (!h) continue;
        oliCountByHash.set(h, (oliCountByHash.get(h) || 0) + 1);
        if (!oliAcctByHash.has(h)) oliAcctByHash.set(h, String((o && (o.account_id ?? o.accountId)) || "").trim());
      }
      const acctById = new Map((planningAccounts || []).map((a) => [String((a && (a.accountId ?? a.id)) || "").trim(), a]));
      const frozenReadinessIsolateSellers = new Set();
      for (const [h, count] of oliCountByHash) {
        if (count !== 1) continue;
        const a = acctById.get(oliAcctByHash.get(h));
        if (a && a.rawSellerId) frozenReadinessIsolateSellers.add(String(a.rawSellerId));
      }
      continuation = { persistedJobs, persistedHashes, frozenByFamily, orgOnly, frozenAccountIds: [...perAccountOwnerIds].sort(), frozenReadinessIsolateSellers };
    }
  }

  // AUTHORIZED FRESH-PLAN SET (req 2) + EXECUTION-READINESS DEFER (FRESH cycle only). On a FRESH cycle the plan is
  // restricted to the POSITIVELY-authorized account set when one is supplied (discovery INTER allowlist); otherwise it
  // falls back to removing only the known-unready exclusion set. Either way, NO create is attempted for a deferred
  // account (it waits as "Setting up"; LKG preserved). A CONTINUATION's planningAccounts is the frozen owner set and
  // is left UNTOUCHED (membership/budget immutable). Discovery (`accounts`) is never filtered, so the frozen-owner
  // safety check above still sees every owner.
  const idOf = (a) => String((a && (a.accountId ?? a.id)) || "").trim();
  const allowlist = freshPlanAccountIds == null ? null
    : (freshPlanAccountIds instanceof Set ? freshPlanAccountIds : new Set([...(freshPlanAccountIds || [])].map((x) => String(x).trim()).filter(Boolean)));
  const preemptiveUnreadySet = preemptiveUnreadyAccountIds instanceof Set ? preemptiveUnreadyAccountIds : new Set(preemptiveUnreadyAccountIds || []);
  let preemptiveDeferredAccounts = [];
  // Accounts in discovery but NOT authorized for THIS fresh wave that are ALSO not known-unready -- i.e. new/unknown
  // accounts that appeared after gating. Reported honestly; they never enter the plan (they cannot bypass onboarding).
  let unauthorizedFreshAccounts = [];
  if (!isContinuation) {
    if (allowlist) {
      const notAllowed = planningAccounts.filter((a) => !allowlist.has(idOf(a))).map(idOf);
      planningAccounts = planningAccounts.filter((a) => allowlist.has(idOf(a)));
      // Split the disallowed set for honest accounting: known-unready (the gate flagged them) vs. not-authorized-this-
      // wave (new/unknown accounts -> a later gated wave only). Both are excluded from the plan; neither creates.
      preemptiveDeferredAccounts = notAllowed.filter((id) => preemptiveUnreadySet.has(id));
      unauthorizedFreshAccounts = notAllowed.filter((id) => !preemptiveUnreadySet.has(id));
    } else if (preemptiveUnreadySet.size) {
      // No positive allowlist (a non-gated caller): defense-in-depth exclusion of the known-unready set only.
      preemptiveDeferredAccounts = planningAccounts.filter((a) => preemptiveUnreadySet.has(idOf(a))).map(idOf);
      if (preemptiveDeferredAccounts.length) planningAccounts = planningAccounts.filter((a) => !preemptiveUnreadySet.has(idOf(a)));
    }
  }
  const plan = planBucketSourceSync({
    apiKey, bucket, accounts: planningAccounts, existingMembership, coverageByAccountId,
    catalogSnapshot, fbaSnapshotsByAccount, pausedSources, asOf, today,
    catalogCarrierSeller,
    forceCatalogRefresh,
    // Readiness isolation: a FRESH cycle uses the evidence-resolved set (shapes + freezes the plan); a CONTINUATION
    // reproduces its frozen split from the DURABLE owners (never the re-resolved set, which could have drifted
    // mid-cycle -> a divergent plan / PLAN_BUDGET_MISMATCH). This lets a split recovery spanning multiple invocations
    // resume instead of deferring, while a never-split cycle stays byte-identical.
    readinessIsolateSellers: isContinuation ? (continuation ? continuation.frozenReadinessIsolateSellers : new Set()) : readinessIsolateSellers,
    // Threaded on BOTH fresh + continuation (stable prior-cycle evidence -> reproducible plan, no frozen state needed).
    oliBackfillWeeklySellers,
  });
  // Honest accounting (req 7): accounts DEFERRED from the fresh plan for execution-readiness (known-unready; no
  // create, they wait as "Setting up", LKG preserved) and accounts EXCLUDED because they are not in the authorized
  // fresh-plan wave (new/unknown accounts that appeared after gating -> a later gated wave only). Both empty on a
  // continuation (frozen membership is immutable) or when no gate set/allowlist was supplied.
  plan.summary = { ...plan.summary, preemptiveDeferredAccounts, unauthorizedFreshAccounts };
  if (continuation) {
    // CONTINUATION PLAN restriction, per family. ORIGINAL-WORK vs NEWLY-ENABLED-WORK is decided ONLY from the ORIGINAL
    // PERSISTED source jobs -- NEVER from the current plan (which reflects the CURRENT pausedSources/coverage/discovery).
    // runSourceJobs upserts EVERY planned family's canonical rows on the first execution pass, BEFORE any tranche
    // executes, so an originally-planned family has persisted jobs even if the run stopped before that family's budget
    // was frozen; a family that was PAUSED at the original freeze has NONE. Three cases per family:
    //   (a) has a frozen budget            -> reuse it; plan = persisted identities INTERSECT frozen hashes.
    //   (b) no budget but HAS persisted jobs -> ORIGINALLY PLANNED, interrupted before its budget freeze: resume from
    //       EXACTLY those persisted identities (the family loop freezes the budget from them); request hashes bind
    //       dates/sellers/marketplaces/row limits/pricing, so nothing regenerated is admitted.
    //   (c) no budget and NO persisted jobs -> NEWLY ENABLED (paused originally / unreadable): NEVER add jobs, budgets,
    //       reservations or exports to THIS cycle -- it joins the NEXT fresh cycle.
    // For (a) and (b), every OPEN persisted ORIGINAL job MUST be reproducible by the current plan, else defer (never a
    // divergent plan). NOTE: source-sync has no separate per-family authorization record -- the deterministic frozen
    // tranche budget IS the spend authorization, so resuming (b) freezes exactly the ceiling that WOULD have been frozen.
    let dropped = 0;
    const resumedUnfrozen = [];
    for (const family of plan.families) {
      const frozen = continuation.frozenByFamily.get(family.sourceKey) || null;
      const orgExcluded = continuation.orgOnly && family.sourceKey !== CATALOG_SOURCE_KEY;
      const persistedFamilyHashes = new Set(
        continuation.persistedJobs.filter((r) => skey(r) === family.sourceKey).map(rowHash).filter(Boolean),
      );
      const before = family.plannedJobs.length;
      let requiredHashes = null; // the ORIGINAL identities this family must reproduce (frozen, or persisted-unfrozen)
      if (orgExcluded) {
        // An organization-only cycle NEVER admits per-account discovery work.
        family.plannedJobs = []; if (Array.isArray(family.units)) family.units = [];
        if (before > 0) family.skippedContinuation = "not-in-frozen-scope";
      } else if (frozen) {
        // (a) FROZEN family: persisted job identities INTERSECT frozen budget hashes ONLY.
        const keep = (h) => continuation.persistedHashes.has(h) && frozen.hashes.has(h);
        family.plannedJobs = family.plannedJobs.filter((j) => keep(j.requestHash));
        if (Array.isArray(family.units)) family.units = family.units.filter((u) => keep(u.requestHash));
        requiredHashes = frozen.hashes;
      } else if (persistedFamilyHashes.size > 0) {
        // (b) ORIGINALLY PLANNED, interrupted before its budget freeze: restrict to EXACTLY the original persisted
        // identities; the family loop freezes the budget from these (never from a regenerated current plan).
        family.plannedJobs = family.plannedJobs.filter((j) => persistedFamilyHashes.has(j.requestHash));
        if (Array.isArray(family.units)) family.units = family.units.filter((u) => persistedFamilyHashes.has(u.requestHash));
        family.originallyPlannedUnfrozen = true;
        requiredHashes = persistedFamilyHashes;
        resumedUnfrozen.push(family.sourceKey);
      } else {
        // (c) NEWLY ENABLED: no original persisted jobs. Enabling it now must NOT add work to THIS cycle.
        family.plannedJobs = []; if (Array.isArray(family.units)) family.units = [];
        if (before > 0) family.skippedContinuation = "newly-enabled-deferred";
      }
      dropped += before - family.plannedJobs.length;
      if (requiredHashes) {
        // Every OPEN persisted ORIGINAL job of this family must be REPRODUCED (identical request identity) by the
        // current plan; otherwise this invocation cannot resume it faithfully -> defer rather than run a different plan.
        const planned = new Set(family.plannedJobs.map((j) => j.requestHash));
        const unreproduced = continuation.persistedJobs.filter((r) => skey(r) === family.sourceKey && OPEN.has(stat(r)) && requiredHashes.has(rowHash(r)) && !planned.has(rowHash(r)));
        if (unreproduced.length) return deferredFrozenScope(bucket, activeCycleId, "frozen-plan-not-reproducible", { detail: `${family.sourceKey}: ${unreproduced.length} open ${frozen ? "frozen" : "originally-planned"} job(s) not reproduced by the current plan` });
      }
    }
    plan.summary = {
      ...plan.summary,
      plannedJobsByFamily: Object.fromEntries(plan.families.map((f) => [f.sourceKey, f.plannedJobs.length])),
      continuation: { cycleId: activeCycleId, orgOnly: continuation.orgOnly, frozenAccounts: continuation.frozenAccountIds.length, droppedUnfrozenJobs: dropped, resumedUnfrozenFamilies: resumedUnfrozen },
    };
  }
  // P0-A COMPLETE-DAILY-PLAN: when executeSourceKeys is set, EXECUTE (create/drain) only those families this step;
  // every OTHER planned family is FREEZE-ONLY (its budget + canonical jobs/owners are committed, but it is left OPEN
  // for a later step -- the priority step drains the frozen Catalog). Reorder so freeze-only families run FIRST: this
  // guarantees their tranche budgets are persisted BEFORE the executed family makes its first paid create ("one
  // complete daily-cycle plan before the first paid create"). runSourceJobs (called on the first EXECUTED family)
  // upserts the FULL planned set's canonical jobs + owners, so a freeze-only family's job/owner are durably persisted
  // even though it creates nothing here. null => execute every family (byte-identical; no reorder).
  const executeSet = executeSourceKeys instanceof Set ? executeSourceKeys : (executeSourceKeys != null ? new Set(executeSourceKeys) : null);
  if (executeSet) {
    const freezeOnly = plan.families.filter((f) => !executeSet.has(f.sourceKey));
    const executed = plan.families.filter((f) => executeSet.has(f.sourceKey));
    plan.families = [...freezeOnly, ...executed];
  }
  const allPlannedJobs = plan.families.flatMap((f) => f.plannedJobs);
  const ownerIds = [...new Set(allPlannedJobs.map((j) => j.owner.ownerId))];

  const rollup = {
    bucket, cycleId: null, plan: plan.summary, skippedPaused: plan.skippedPaused,
    families: [], stopped: false, stopReason: null, globalDrained: false,
    deadlineReached: false, continuationRequired: false,
    history: { rowsPersisted: 0, accountsCovered: 0 }, snapshots: { recorded: [], rejected: [] },
  };

  let lastFamilyCompletedAt = null;
  const enforceCooldown = async () => {
    if (!(cooldownMs > 0) || lastFamilyCompletedAt == null) return;
    const target = lastFamilyCompletedAt + Number(cooldownMs);
    while (clock() < target) await wait(Math.max(1, target - clock()));
  };

  for (const family of plan.families) {
    if (!family.plannedJobs.length) {
      rollup.families.push({ sourceKey: family.sourceKey, continuations: 0, state: null, skipped: family.skippedContinuation || "nothing-to-do" });
      continue;
    }
    // Finding 3: stop BEFORE launching a family the budget cannot fit; the rollup is typed-resumable.
    if (outOfTime()) {
      rollup.deadlineReached = true;
      rollup.continuationRequired = true;
      rollup.families.push({ sourceKey: family.sourceKey, continuations: 0, state: null, skipped: "deadline" });
      break;
    }
    await enforceCooldown();
    if (updateRunStatus) {
      await updateRunStatus({ sourceKey: family.sourceKey, bucket, lastStatus: "running", lastAttemptAt: nowIso() });
    }

    // Frozen family ceiling (Blocker 4d): computed from THIS bucket plan's family jobs, persisted before the
    // first create. FBA is premium (5 tokens/create); OLI + catalog standard (2). Registry-priced.
    const tranche = makeSourceTranche({ name: family.sourceKey, sourceKeys: [family.sourceKey] });
    const trancheKey = `source-sync:${family.sourceKey}`;
    let budget = null;
    if (budgets && typeof store.persistBudget === "function") {
      if (isContinuation) {
        // STRICT CONTINUATION (P0-2): REUSE the already-persisted frozen budget verbatim (read UP FRONT above; a read
        // failure already deferred before any mutation) -- NEVER recompute or re-persist from current discovery. A
        // family with NO frozen budget row is genuinely unplanned in this cycle: SKIP it (zero jobs/reservations/
        // POSTs) -- it joins the NEXT fresh cycle. LKG preserved either way.
        const frozen = continuation && continuation.frozenByFamily.get(family.sourceKey);
        if (frozen && frozen.trancheKey === trancheKey) {
          // (a) already had a frozen budget: REUSE it verbatim (never recompute/re-persist from current discovery).
          rollup.cycleId = rollup.cycleId || activeCycleId;
          budget = { trancheKey: frozen.trancheKey, planFingerprint: frozen.planFingerprint };
        } else if (family.originallyPlannedUnfrozen) {
          // (b) ORIGINALLY PLANNED, interrupted before its budget freeze. family.plannedJobs was already restricted
          // (above) to EXACTLY the original persisted identities, and every open original job proven reproducible.
          // Freeze the budget from those persisted identities ONLY -- the deterministic freeze reproduces the ceiling
          // that WOULD have been frozen originally. A same-plan re-persist is an idempotent "exists" (replay-safe).
          const frozenNow = computeFrozenTrancheBudget({ plannedJobs: family.plannedJobs, sourceTranche: tranche, isPremiumOf: registryIsPremiumOf, trancheKey });
          if (frozenNow.maxCreates > 0) {
            rollup.cycleId = rollup.cycleId || activeCycleId;
            const ack = await store.persistBudget({
              cycleId: activeCycleId, trancheKey: frozenNow.trancheKey, planFingerprint: frozenNow.planFingerprint,
              maxCreates: frozenNow.maxCreates, maxTokens: frozenNow.maxTokens,
              hashes: frozenNow.hashes.map((h) => ({ requestHash: h.requestHash, tokenCost: h.tokenCost })),
            });
            if (ack !== "created" && ack !== "exists") throw new Error(`runBucketSourceSync: malformed budget acknowledgement "${ack}" (fail closed).`);
            budget = { trancheKey: frozenNow.trancheKey, planFingerprint: frozenNow.planFingerprint };
          }
        } else {
          // (c) NEWLY ENABLED / org-excluded / no original evidence: NEVER fund on an active cycle. (Such families were
          // emptied above and are caught at the top of the loop; this is a defensive skip.)
          rollup.families.push({ sourceKey: family.sourceKey, continuations: 0, state: null, skipped: family.skippedContinuation || "not-in-frozen-scope" });
          continue;
        }
      } else {
        // FRESH cycle: compute + persist the frozen budget from the current plan (first freeze).
        const frozen = computeFrozenTrancheBudget({
          plannedJobs: family.plannedJobs, sourceTranche: tranche,
          isPremiumOf: registryIsPremiumOf, trancheKey,
        });
        if (frozen.maxCreates > 0) {
          const cycleId = activeCycleId || await store.openCycle({ bucket: cycleKeyBucket, cycleDate, scheduledAt, trigger });
          rollup.cycleId = rollup.cycleId || cycleId;
          const ack = await store.persistBudget({
            cycleId, trancheKey: frozen.trancheKey, planFingerprint: frozen.planFingerprint,
            maxCreates: frozen.maxCreates, maxTokens: frozen.maxTokens,
            hashes: frozen.hashes.map((h) => ({ requestHash: h.requestHash, tokenCost: h.tokenCost })),
          });
          if (ack !== "created" && ack !== "exists") {
            throw new Error(`runBucketSourceSync: malformed budget acknowledgement "${ack}" (fail closed).`);
          }
          budget = { trancheKey: frozen.trancheKey, planFingerprint: frozen.planFingerprint };
        }
      }
    }

    // P0-A FREEZE-ONLY: this family's tranche budget is now committed (above) and its canonical job/owner will be
    // upserted by the EXECUTED family's runSourceJobs upsert-all pass. It is NOT created/drained THIS step -- it stays
    // OPEN on the cycle so the later step (the priority Product Catalog step) drains it as a case-(a) continuation.
    // globalDrained therefore stays false for THIS step (the open family), which is correct: the OLI step must not
    // derive; the priority step derives after Catalog drains. Reordering put freeze-only families FIRST, so the budget
    // is frozen BEFORE the executed family's first paid create.
    if (executeSet && !executeSet.has(family.sourceKey)) {
      rollup.cycleId = rollup.cycleId || activeCycleId;
      rollup.families.push({ sourceKey: family.sourceKey, continuations: 0, state: null, skipped: "frozen-not-executed-this-step" });
      continue;
    }

    let continuations = 0;
    let state = null;
    let prevSignature = null;
    let stalls = 0;
    while (continuations < maxContinuationsPerFamily) {
      const res = await runSourceJobs({
        store, dataDoe, plannedJobs: allPlannedJobs, ownerIds,
        bucket, cycleBucket, cycleDate, scheduledAt, trigger, clock, deadlineMs, reserveMs,
        sourceTranche: tranche, reuseOnly, budget, forceFreshOli, cycleId: activeCycleId,
      });
      continuations += 1;
      rollup.cycleId = res.cycleId || rollup.cycleId;
      state = await familyState(store, rollup.cycleId, family.sourceKey);
      if (state.open === 0) break;
      if (res.deadlineReached || outOfTime()) { rollup.deadlineReached = true; break; }
      const signature = JSON.stringify(state);
      if ((res.deferred || 0) > 0) stalls = 0;
      else if (signature === prevSignature) stalls += 1;
      else stalls = 0;
      prevSignature = signature;
      if (stalls >= 1) break; // no further progress possible this invocation
    }

    rollup.families.push({ sourceKey: family.sourceKey, continuations, state });

    if (state && state.open > 0) {
      // Finding 3: an out-of-time family is RESUMABLE work, never a failure -- a fresh invocation re-enters
      // the same cycle (persisted export ids resume; no hash is ever recreated). Only genuinely blocked work
      // (failed jobs, or a no-progress stall) stops the bucket typed.
      if (rollup.deadlineReached) {
        rollup.continuationRequired = true;
        if (updateRunStatus) await updateRunStatus({ sourceKey: family.sourceKey, bucket, lastStatus: "running" });
        break;
      }
      rollup.stopped = true;
      rollup.stopReason = Object.freeze({ code: state.failed > 0 ? "REQUIRED_SOURCE_FAILED" : "FAMILY_INCOMPLETE", family: family.sourceKey, state });
      if (updateRunStatus) await updateRunStatus({ sourceKey: family.sourceKey, bucket, lastStatus: "failed", safeErrorCode: rollup.stopReason.code, safeErrorStage: "source" });
      break;
    }
    lastFamilyCompletedAt = clock();

    // ---- durable persistence for the completed family (successful jobs only; failures preserve LKG) ----
    if (family.sourceKey === OLI_SOURCE_KEY && replaceHistoryWindow) {
      // Finding 5: PER (account, slice) the data replacement and its coverage acknowledgement are ONE
      // atomic operation (the replace_oli_history_window RPC in production; the injected model in tests):
      // the account's rows inside the slice window are deleted and re-inserted from the corrected export,
      // so a grain that DISAPPEARED cannot survive, and coverage acknowledges the window in the SAME
      // transaction -- an empty per-account slice is valid zero-sales evidence (delete + ack only).
      const rows = await store.listSourceJobs(rollup.cycleId);
      const byHash = new Map(rows.map((r) => [r.request_hash ?? r.requestHash, r]));
      const coveredAccounts = new Set();
      for (const unit of family.units) {
        const row = byHash.get(unit.requestHash);
        if (!row || stat(row) !== "succeeded") continue;
        if (outOfTime()) { rollup.deadlineReached = true; rollup.continuationRequired = true; break; }
        const payload = await loadPayloadOrNull(store, unit.requestHash);
        // Finding 4/round-4 finding 5: a SUCCEEDED job whose cached payload is missing/UNREADABLE/malformed
        // is a typed fail-closed stop -- the family is NOT treated as drained/successful, durable
        // persistence is NOT silently skipped, and LKG (previous history + coverage) stays untouched.
        if (!payload || !Array.isArray(payload.rows)) {
          rollup.stopped = true;
          rollup.stopReason = Object.freeze({ code: "SOURCE_PAYLOAD_UNAVAILABLE", family: OLI_SOURCE_KEY, requestHash: unit.requestHash });
          break;
        }
        const accountsBySellerId = Object.fromEntries(unit.accounts.map((a) => [a.rawSellerId, { accountId: a.accountId, currency: a.currency }]));
        // DIMENSIONAL persist: the fragment now carries amazon_order_status / fulfillment_channel / address_state /
        // address_city / item_status. The builder validates the authoritative order rules PER ACCOUNT and classifies
        // by the ITEM-LEVEL signal: an account with a not-yet-itemized / pre-sale row is HELD (OLI_D1_PENDING_ITEMIZATION
        // -- expected Amazon item-level lag), an itemized-but-null row is a real defect (OLI_ITEMIZED_VALUE_MISSING),
        // and a missing-status row is refused (OLI_ORDER_STATUS_MISSING). A blocked account's window is never written,
        // its coverage never advanced, LKG preserved, and it is reported with a redacted itemization summary. The
        // builder returns the dimensional rows + the non-cancelled daily rollup for each fully-resolved account.
        const { byAccount, rollupByAccount, orderAuditByAccount, operationalUnitsByAccount, blocked, completenessByAccount } = oliDimensionalRowsFromFragment({
          rows: payload.rows, accountsBySellerId,
          organizationFingerprint: family.plannedJobs[0].organizationFingerprint,
          connectionId: "primary", sourceRequestHash: unit.requestHash,
        });
        if (blocked.length) {
          rollup.blockedAccounts = rollup.blockedAccounts || [];
          for (const b of blocked) {
            rollup.blockedAccounts.push({ ...b, coveredFrom: unit.slice.from, coveredTo: unit.slice.to, family: OLI_SOURCE_KEY });
            // A real DEFECT (itemized recognized-sale with a null value) keeps the account's LKG but records a
            // 'source-defect' completeness row for the requested date so the admin escalation surfaces it.
            if (recordCompleteness && b.code === "OLI_ITEMIZED_VALUE_MISSING") {
              try {
                await recordCompleteness({
                  organizationFingerprint: family.plannedJobs[0].organizationFingerprint, connectionId: "primary",
                  accountId: b.accountId, bucket, saleDate: unit.slice.to, status: "source-defect",
                  itemizedOrderCount: (b.detail && b.detail.resolved) || 0, pendingOrderCount: (b.detail && b.detail.pending) || 0,
                  itemizedUnitCount: 0, pendingUnitCount: 0, defectCount: (b.detail && b.detail.defect) || 1,
                  itemizationPercent: (b.detail && b.detail.itemizedPct) || 0,
                  requestedAsOf: unit.slice.to, provenExportThrough: unit.slice.to,
                  sourceRequestHashes: [unit.requestHash], sourceExportIds: [],
                  refreshedAt: nowIso(),
                });
              } catch (e) { (rollup.completenessErrors = rollup.completenessErrors || []).push({ accountId: b.accountId, saleDate: unit.slice.to, error: String(e && e.message ? e.message : e) }); }
            }
          }
        }
        const blockedSet = new Set(blocked.map((b) => b.accountId));
        for (const a of unit.accounts) {
          if (blockedSet.has(a.accountId)) continue; // refused account: LKG preserved, reported in blockedAccounts
          if (outOfTime()) { rollup.deadlineReached = true; rollup.continuationRequired = true; break; }
          const dimRows = byAccount.get(a.accountId) || [];
          const rollupRows = rollupByAccount.get(a.accountId) || [];
          // The order-level audit rows (dimensional grain + amazon_order_id) ride the SAME atomic replace as the
          // dimensional/rollup evidence, from the SAME validated export -- no second export, no separate transaction.
          const orderRows = (orderAuditByAccount && orderAuditByAccount.get(a.accountId)) || [];
          // The operational-unit rows (EVERY observed unit: priced / explicit-zero / pending / cancelled) ride the
          // SAME atomic replace. A covered account ALWAYS passes an array (an empty [] clears a now-inactive window),
          // so the operational units can never drift from the priced rollup they commit alongside.
          const unitRows = (operationalUnitsByAccount && operationalUnitsByAccount.get(a.accountId)) || [];
          const outcome = await replaceHistoryWindow({
            organizationFingerprint: family.plannedJobs[0].organizationFingerprint,
            connectionId: "primary", accountId: a.accountId,
            coveredFrom: unit.slice.from, coveredTo: unit.slice.to,
            rows: dimRows, rollupRows, orderRows, unitRows, sourceRefreshedAt: nowIso(),
          });
          if (outcome && (outcome.write === "value-missing" || outcome.write === "status-missing")) {
            // The RPC's last-line-of-defence validation refused this window (JS builder should have caught it, but
            // the DB is authoritative): treat exactly like a blocked account -- LKG preserved, reported, never fatal.
            rollup.blockedAccounts = rollup.blockedAccounts || [];
            rollup.blockedAccounts.push({ accountId: a.accountId, code: outcome.error, coveredFrom: unit.slice.from, coveredTo: unit.slice.to, family: OLI_SOURCE_KEY });
            continue;
          }
          if (!outcome || outcome.write !== "ok") {
            rollup.stopped = true;
            rollup.stopReason = Object.freeze({ code: "HISTORY_REPLACE_FAILED", family: OLI_SOURCE_KEY, accountId: a.accountId });
            break;
          }
          rollup.history.rowsPersisted += dimRows.length;
          coveredAccounts.add(a.accountId);
          // Two-layer COMPLETENESS: record each date's provisional/final state for this covered account (the itemized
          // window is now PUBLISHED; a date with pending orders is provisional). Provenance-checked CAS -- final never
          // regresses, a stale export never clobbers newer. Non-fatal: the sales already persisted; the next run
          // re-records idempotently.
          const comp = completenessByAccount && completenessByAccount.get(a.accountId);
          if (recordCompleteness) {
            const writeOne = async (saleDate, dc) => {
              try {
                const res = await recordCompleteness({
                  organizationFingerprint: family.plannedJobs[0].organizationFingerprint, connectionId: "primary",
                  accountId: a.accountId, bucket, saleDate, status: dc.completenessStatus,
                  itemizedOrderCount: dc.itemizedOrderCount, pendingOrderCount: dc.pendingOrderCount,
                  itemizedUnitCount: dc.itemizedUnitCount, pendingUnitCount: dc.pendingUnitCount,
                  defectCount: 0, itemizationPercent: dc.itemizationPercent,
                  requestedAsOf: unit.slice.to, provenExportThrough: unit.slice.to,
                  sourceRequestHashes: [unit.requestHash], sourceExportIds: row.export_id ? [String(row.export_id)] : [],
                  refreshedAt: nowIso(),
                });
                (rollup.completeness = rollup.completeness || []).push({ accountId: a.accountId, saleDate, status: dc.completenessStatus, itemizationPercent: dc.itemizationPercent, disposition: res && res.disposition });
              } catch (e) {
                (rollup.completenessErrors = rollup.completenessErrors || []).push({ accountId: a.accountId, saleDate, error: String(e && e.message ? e.message : e) });
              }
            };
            const FINAL_ZERO = { completenessStatus: "final", itemizedOrderCount: 0, pendingOrderCount: 0, itemizedUnitCount: 0, pendingUnitCount: 0, itemizationPercent: 100 };
            if (comp && comp.byDate && comp.byDate.size) {
              for (const [saleDate, dc] of comp.byDate) await writeOne(saleDate, dc);
              // A covered account with rows but NONE on the requested D-1 (an inactive D-1) -> explicit FINAL (0 orders).
              if (!comp.byDate.has(unit.slice.to)) await writeOne(unit.slice.to, FINAL_ZERO);
            } else {
              // A FULLY-inactive account (zero OLI rows in the whole window) still has its D-1 window covered (empty
              // slice = valid zero-sales evidence). Label its D-1 explicit FINAL (0 orders, 100%) so EVERY covered
              // account is labelled -- never left unlabelled, never a false provisional, never a fabricated sale.
              await writeOne(unit.slice.to, FINAL_ZERO);
            }
          }
        }
        if (rollup.stopped || rollup.deadlineReached) break;
      }
      if (rollup.stopped || rollup.deadlineReached) break;
      rollup.history.accountsCovered += coveredAccounts.size;
    }

    if (family.sourceKey === CATALOG_SOURCE_KEY && family.plannedJobs.length) {
      // Round-5 blocker 4: the CATALOG persistence is deadline-checked like every other persistence path --
      // an expired budget defers it typed-resumable (a fresh invocation persists from the intact cache).
      if (outOfTime()) { rollup.deadlineReached = true; rollup.continuationRequired = true; break; }
      const job = family.plannedJobs[0];
      const rows = await store.listSourceJobs(rollup.cycleId);
      const row = rows.find((r) => (r.request_hash ?? r.requestHash) === job.requestHash);
      if (row && stat(row) === "succeeded") {
        const payload = await loadPayloadOrNull(store, job.requestHash);
        // Finding 4: a succeeded catalog job with a lost/unreadable cached payload fails closed typed.
        if (!payload || !Array.isArray(payload.rows)) {
          rollup.stopped = true;
          rollup.stopReason = Object.freeze({ code: "SOURCE_PAYLOAD_UNAVAILABLE", family: CATALOG_SOURCE_KEY, requestHash: job.requestHash, detail: "missing-or-malformed" });
          break;
        }
        // Round-4 finding 5: a DOMAIN-INVALID catalog (unbuildable brand maps) is the SAME typed stop --
        // never a silent skip; the previous validated snapshot stays latest-good.
        let validated = false;
        try { buildBrandMaps(payload.rows); validated = true; } catch (_e) { validated = false; }
        if (!validated) {
          rollup.stopped = true;
          rollup.stopReason = Object.freeze({ code: "SOURCE_PAYLOAD_UNAVAILABLE", family: CATALOG_SOURCE_KEY, requestHash: job.requestHash, detail: "domain-invalid" });
          break;
        }
        if (persistSnapshot) {
          // Finding 6: the collaborator receives the ROWS -- production COPIES them into the durable
          // source-snapshots/* namespace (never pruned with the 24h cache) and records THAT pointer.
          await persistSnapshot({
            sourceKey: CATALOG_SOURCE_KEY, scopeKey: catalogSnapshotScope(),
            rows: payload.rows, rowCount: payload.rows.length,
            sourceRequestHash: job.requestHash, validatedAt: nowIso(),
          });
          rollup.snapshots.recorded.push(CATALOG_SOURCE_KEY);
        }
      }
    }

    if (family.sourceKey === FBA_INVENTORY_SOURCE_KEY && family.plannedJobs.length) {
      const rows = await store.listSourceJobs(rollup.cycleId);
      const byHash = new Map(rows.map((r) => [r.request_hash ?? r.requestHash, r]));
      for (const job of family.plannedJobs) {
        const row = byHash.get(job.requestHash);
        if (!row || stat(row) !== "succeeded") continue;
        if (outOfTime()) { rollup.deadlineReached = true; rollup.continuationRequired = true; break; }
        const payload = await loadPayloadOrNull(store, job.requestHash);
        // Finding 4: a succeeded FBA job with a lost/unreadable cached payload fails closed typed.
        if (!payload || !Array.isArray(payload.rows)) {
          rollup.stopped = true;
          rollup.stopReason = Object.freeze({ code: "SOURCE_PAYLOAD_UNAVAILABLE", family: FBA_INVENTORY_SOURCE_KEY, requestHash: job.requestHash, detail: "missing-or-malformed" });
          break;
        }
        // Finding 10 + round-4 finding 5: a DOMAIN-INVALID payload (blank/mismatched marketplace rows) is
        // the SAME typed fail-closed stop -- recorded for the account, bucket non-drained, latest-good kept.
        const fv = validateFbaSnapshotRows(payload.rows, job.marketplaceConstraint);
        if (!fv.valid) {
          rollup.snapshots.rejected.push({ sourceKey: FBA_INVENTORY_SOURCE_KEY, accountId: job.owner.accountId, code: fv.code });
          rollup.stopped = true;
          rollup.stopReason = Object.freeze({ code: "SOURCE_PAYLOAD_UNAVAILABLE", family: FBA_INVENTORY_SOURCE_KEY, requestHash: job.requestHash, detail: fv.code });
          break;
        }
        if (persistSnapshot) {
          await persistSnapshot({
            sourceKey: FBA_INVENTORY_SOURCE_KEY, scopeKey: job.owner.accountId,
            rows: payload.rows, rowCount: payload.rows.length,
            sourceRequestHash: job.requestHash, validatedAt: nowIso(),
          });
          rollup.snapshots.recorded.push(`${FBA_INVENTORY_SOURCE_KEY}:${job.owner.accountId}`);
        }
      }
      if (rollup.stopped) break; // finding 4: a lost payload stops the bucket typed
    }

    if (updateRunStatus) {
      const failedAny = state && state.failed > 0;
      await updateRunStatus({
        sourceKey: family.sourceKey, bucket,
        lastStatus: failedAny ? "partial" : "succeeded",
        lastSuccessAt: failedAny ? undefined : nowIso(),
        accountsTotal: accounts.length,
        batchCount: plan.batches.length,
      });
    }

    // REQUIRED-source policy: OLI + catalog are required by the priority dashboards; a terminal failure in a
    // completed family stops this bucket before the next family launches (LKG intact; other bucket unaffected).
    // EXCEPTION: a failure that is ONLY the typed readiness deferral (DATADOE_INITIAL_LOAD_INCOMPLETE) does NOT
    // block -- the healthy sellers that succeeded still derive/publish, and the unready seller stays "waiting"
    // (self-healing via next fresh cycle's isolation/exclusion). Any NON-readiness failure still stops the bucket.
    const realFailed = (state ? state.failed : 0) - (state ? (state.readinessWaiting || 0) : 0) - (state ? (state.deferredPending || 0) : 0);
    if (state && realFailed > 0 && sourceRegistryEntry(family.sourceKey).usedByReports.length > 0
      && family.sourceKey !== FBA_INVENTORY_SOURCE_KEY) {
      rollup.stopped = true;
      rollup.stopReason = Object.freeze({ code: "REQUIRED_SOURCE_FAILED", family: family.sourceKey, state });
      break;
    }
    // A completed required family whose ONLY failures are the zero-export reconciler's no-export deferrals (the durable
    // source is not adoptable THIS pass) stops the bucket RETRYABLY -- SOURCE_READINESS_PENDING threads through the
    // release runner as the derive reason, which statusFromRelease maps to a retryable DEFERRED_DEPENDENCY (LKG
    // preserved; the source materializes on the next natural cycle), never a hard REQUIRED_SOURCE_FAILED. deferredPending
    // is 0 on the scheduled full-region path (its real adapter never emits SOURCE_READINESS_PENDING), so that path is
    // byte-identical; a real terminal failure mixed in keeps realFailed>0 and hard-stops above (a defect is never masked).
    if (state && realFailed <= 0 && (state.deferredPending || 0) > 0 && sourceRegistryEntry(family.sourceKey).usedByReports.length > 0
      && family.sourceKey !== FBA_INVENTORY_SOURCE_KEY) {
      rollup.stopped = true;
      rollup.stopReason = Object.freeze({ code: "SOURCE_READINESS_PENDING", family: family.sourceKey, state });
      break;
    }
  }

  // The derive is authorized ONLY off a genuine, DRAINED owning cycle. A run that opened NO cycle (no family had
  // anything to fetch) is NOT "drained" -- it stays globalDrained=false so the derive/save stage is skipped
  // (not-drained). Deriving + saving report snapshots from durable evidence WITHOUT an owning cycle (and thus
  // without claim-before-save lineage) is the SEPARATE durable-evidence-lineage rework, deliberately out of this
  // initial-backfill-only scope; until then a zero-work run publishes/schedules nothing.
  if (rollup.cycleId) {
    const rows = await store.listSourceJobs(rollup.cycleId);
    rollup.globalDrained = !rollup.stopped && rows.length > 0 && rows.every((r) => !OPEN.has(stat(r)));
  }
  return rollup;
}
