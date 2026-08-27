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
import { plannedSourceJob, plannedBatchSourceJobs } from "./source-sync-driver.js";
import { runSourceJobs } from "./source-worker.js";
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

const FBA_SNAPSHOT_LOOKBACK_DAYS = 10; // mirrors fba-plan:inventory-health "range:asOf-10d..asOf"

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
    from: addDaysStr(asOf, -FBA_SNAPSHOT_LOOKBACK_DAYS), to: asOf, limit: c.limit, options,
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
    from: addDaysStr(asOf, -FBA_SNAPSHOT_LOOKBACK_DAYS), to: asOf, options,
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
} = {}) {
  if (bucket !== "us" && bucket !== "non-us") throw new Error(`planBucketSourceSync requires bucket 'us'|'non-us' (got "${bucket}").`);
  if (!Array.isArray(accounts) || accounts.length === 0) throw new Error("planBucketSourceSync requires this bucket's non-empty account list (fail closed).");
  if (!isDateStr(asOf) || !isDateStr(today)) throw new Error("planBucketSourceSync requires YYYY-MM-DD asOf + today (fail closed).");
  for (const a of accounts) {
    if (!a || !String(a.accountId || "").trim() || !String(a.rawSellerId || "").trim()) {
      throw new Error("planBucketSourceSync: every account requires accountId + rawSellerId (fail closed).");
    }
  }

  // 1) STABLE <=5-account batches; existing membership preserved, new accounts join without reshuffling.
  const { membership, batches } = assignAccountBatches(accounts, existingMembership, MAX_ACCOUNTS_PER_BATCH);

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
      for (const batch of batches) {
        const members = batch.accounts;
        const clippedCoverage = Object.fromEntries(members.map((a) => [
          a.accountId, clipCoverageForRefresh(coverageByAccountId[a.accountId] || [], refresh.from),
        ]));
        const units = planOliSliceExports({ batchAccounts: members, coverageByAccountId: clippedCoverage, from: backfill.from, to: backfill.to });
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
  const state = { total: 0, open: 0, succeeded: 0, failed: 0 };
  if (!cycleId) return state;
  for (const r of await store.listSourceJobs(cycleId)) {
    if (skey(r) !== sourceKey) continue;
    state.total += 1;
    const s = stat(r);
    if (OPEN.has(s)) state.open += 1;
    else if (s === "succeeded") state.succeeded += 1;
    else if (s === "failed") state.failed += 1;
  }
  return state;
}

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
  replaceHistoryWindow = null, persistSnapshot = null, updateRunStatus = null,
  cycleDate, scheduledAt = null, trigger = "manual",
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
} = {}) {
  if (!store || typeof store.listSourceJobs !== "function") throw new Error("runBucketSourceSync requires the injected store (fail closed).");
  if (Number(cooldownMs) > 0 && typeof wait !== "function") {
    throw new Error("runBucketSourceSync: a positive cooldown requires an injected wait(ms) collaborator (fail closed).");
  }
  const outOfTime = () => deadlineMs !== Infinity && clock() >= deadlineMs - reserveMs;

  const plan = planBucketSourceSync({
    apiKey, bucket, accounts, existingMembership, coverageByAccountId,
    catalogSnapshot, fbaSnapshotsByAccount, pausedSources, asOf, today,
    catalogCarrierSeller,
    forceCatalogRefresh,
  });
  const allPlannedJobs = plan.families.flatMap((f) => f.plannedJobs);
  const ownerIds = [...new Set(allPlannedJobs.map((j) => j.owner.ownerId))];
  const nowIso = () => new Date(clock()).toISOString();

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
      rollup.families.push({ sourceKey: family.sourceKey, continuations: 0, state: null, skipped: "nothing-to-do" });
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
    let budget = null;
    if (budgets && typeof store.persistBudget === "function") {
      const frozen = computeFrozenTrancheBudget({
        plannedJobs: family.plannedJobs, sourceTranche: tranche,
        isPremiumOf: registryIsPremiumOf, trancheKey: `source-sync:${family.sourceKey}`,
      });
      if (frozen.maxCreates > 0) {
        const cycleId = await store.openCycle({ bucket, cycleDate, scheduledAt, trigger });
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

    let continuations = 0;
    let state = null;
    let prevSignature = null;
    let stalls = 0;
    while (continuations < maxContinuationsPerFamily) {
      const res = await runSourceJobs({
        store, dataDoe, plannedJobs: allPlannedJobs, ownerIds,
        bucket, cycleDate, scheduledAt, trigger, clock, deadlineMs, reserveMs,
        sourceTranche: tranche, reuseOnly, budget, forceFreshOli,
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
        // address_city. The builder validates the authoritative order rules PER ACCOUNT (a value-missing / missing-
        // status account is BLOCKED -- its window is never written, its coverage never advanced, LKG preserved --
        // and reported), and returns the dimensional rows + the non-cancelled daily rollup for each good account.
        const { byAccount, rollupByAccount, orderAuditByAccount, blocked } = oliDimensionalRowsFromFragment({
          rows: payload.rows, accountsBySellerId,
          organizationFingerprint: family.plannedJobs[0].organizationFingerprint,
          connectionId: "primary", sourceRequestHash: unit.requestHash,
        });
        if (blocked.length) {
          rollup.blockedAccounts = rollup.blockedAccounts || [];
          for (const b of blocked) rollup.blockedAccounts.push({ ...b, coveredFrom: unit.slice.from, coveredTo: unit.slice.to, family: OLI_SOURCE_KEY });
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
          const outcome = await replaceHistoryWindow({
            organizationFingerprint: family.plannedJobs[0].organizationFingerprint,
            connectionId: "primary", accountId: a.accountId,
            coveredFrom: unit.slice.from, coveredTo: unit.slice.to,
            rows: dimRows, rollupRows, orderRows, sourceRefreshedAt: nowIso(),
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
    if (state && state.failed > 0 && sourceRegistryEntry(family.sourceKey).usedByReports.length > 0
      && family.sourceKey !== FBA_INVENTORY_SOURCE_KEY) {
      rollup.stopped = true;
      rollup.stopReason = Object.freeze({ code: "REQUIRED_SOURCE_FAILED", family: family.sourceKey, state });
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
