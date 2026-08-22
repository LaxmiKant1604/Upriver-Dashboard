// Scheduler v2 -- US / NON-US BUCKET SOURCE SYNC (Phase 4; offline-composable, ZERO ambient I/O).
//
// ONE operator action per marketplace bucket ("all non-US accounts" / "all US accounts") = ONE orchestration
// run -- NEVER one unlimited DataDoe POST. Internally:
//   - every export covers AT MOST five compatible accounts (the stable batch engine; assignAccountBatches
//     preserves existing membership, so a newly discovered account joins a non-full batch or a fresh one and
//     NOTHING reshuffles);
//   - per canonical OLI slice, the export is scoped to EXACTLY the batch members whose durable coverage does
//     not prove that slice (planOliSliceExports): the steady-state rolling refresh is one batch export per
//     slice, a new account backfills SOLO, and completed accounts are never re-exported;
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
  oliHistoryRowsFromFragment, snapshotRefreshDecision, catalogSnapshotScope, ORGANIZATION_SCOPE_KEY,
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

// The durable organization-wide catalog request: the ONLY catalog spec that fetches `sku` (the brand
// resolution SKU fallback needs it). A NEW VERSIONED request key/columns => a NEW request_hash by design --
// every existing per-report catalog contract (and its golden hash) stays byte-identical.
export const DURABLE_CATALOG_COLUMNS = Object.freeze(["child_asin", "parent_asin", "product_name", "product_brand", "sku"]);
export const DURABLE_CATALOG_ROW_LIMIT = 20000;

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

// The durable org-wide catalog request (once per organization per day; bucket-free identity).
export function resolvedDurableCatalog({ apiKey, asOf, bucket }) {
  if (!isDateStr(asOf)) throw new Error("resolvedDurableCatalog requires a YYYY-MM-DD asOf (fail closed).");
  const sourceId = sourceContractForKey(CATALOG_SOURCE_KEY).ids[0];
  const options = { orderByColumn: "child_asin", orderByDirection: "ASC" };
  const identity = sourceRequestIdentity({
    apiKey, sourceId, columns: [...DURABLE_CATALOG_COLUMNS], ids: [],
    from: asOf, to: asOf, limit: DURABLE_CATALOG_ROW_LIMIT, options,
  });
  return {
    ...identity,
    requestKey: DURABLE_CATALOG_REQUEST_KEY,
    sourceId, sourceKey: CATALOG_SOURCE_KEY,
    bucket, strict: true, limit: DURABLE_CATALOG_ROW_LIMIT,
    sourceScope: "organization", marketplaceScoped: false,
    sellerOrVendorIds: [],
    columns: [...DURABLE_CATALOG_COLUMNS],
    from: asOf, to: asOf, options,
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

  // 2) OLI: per batch, per canonical slice, the member subset whose coverage does not prove it. The rolling
  //    refresh window is always re-exported (idempotent replace); completed history is never re-exported.
  if (pausedSources.has(OLI_SOURCE_KEY)) {
    skippedPaused.push(OLI_SOURCE_KEY);
  } else {
    const backfill = oliBackfillWindow(asOf);
    const refresh = oliRollingRefreshWindow(asOf);
    const oliJobs = [];
    const allUnits = [];
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
    families.push({ sourceKey: OLI_SOURCE_KEY, plannedJobs: oliJobs, units: allUnits });
  }

  // 3) CATALOG: once per ORGANIZATION per day (never per dashboard or per seller).
  if (pausedSources.has(CATALOG_SOURCE_KEY)) {
    skippedPaused.push(CATALOG_SOURCE_KEY);
  } else {
    const decision = snapshotRefreshDecision({ sourceKey: CATALOG_SOURCE_KEY, lastValidatedAt: catalogSnapshot && catalogSnapshot.validated_at, today });
    const catalogJobs = [];
    if (decision.refresh) {
      const resolved = resolvedDurableCatalog({ apiKey, asOf: today, bucket });
      catalogJobs.push(plannedSourceJob(SOURCE_SYNC_OWNER_REPORT_KEY, resolved, bucket, "primary", ORGANIZATION_SCOPE_KEY));
    }
    families.push({ sourceKey: CATALOG_SOURCE_KEY, plannedJobs: catalogJobs, decision });
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
} = {}) {
  if (!store || typeof store.listSourceJobs !== "function") throw new Error("runBucketSourceSync requires the injected store (fail closed).");
  if (Number(cooldownMs) > 0 && typeof wait !== "function") {
    throw new Error("runBucketSourceSync: a positive cooldown requires an injected wait(ms) collaborator (fail closed).");
  }
  const outOfTime = () => deadlineMs !== Infinity && clock() >= deadlineMs - reserveMs;

  const plan = planBucketSourceSync({
    apiKey, bucket, accounts, existingMembership, coverageByAccountId,
    catalogSnapshot, fbaSnapshotsByAccount, pausedSources, asOf, today,
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
        sourceTranche: tranche, reuseOnly, budget,
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
        const accountsBySellerId = Object.fromEntries(unit.accounts.map((a) => [a.rawSellerId, { accountId: a.accountId }]));
        const historyRows = oliHistoryRowsFromFragment({
          rows: payload.rows, accountsBySellerId,
          organizationFingerprint: family.plannedJobs[0].organizationFingerprint,
          connectionId: "primary", sourceRequestHash: unit.requestHash,
        });
        const byAccount = new Map(unit.accounts.map((a) => [a.accountId, []]));
        for (const hr of historyRows) byAccount.get(hr.accountId).push(hr);
        for (const a of unit.accounts) {
          if (outOfTime()) { rollup.deadlineReached = true; rollup.continuationRequired = true; break; }
          const outcome = await replaceHistoryWindow({
            organizationFingerprint: family.plannedJobs[0].organizationFingerprint,
            connectionId: "primary", accountId: a.accountId,
            coveredFrom: unit.slice.from, coveredTo: unit.slice.to,
            rows: byAccount.get(a.accountId), sourceRefreshedAt: nowIso(),
          });
          if (!outcome || outcome.write !== "ok") {
            rollup.stopped = true;
            rollup.stopReason = Object.freeze({ code: "HISTORY_REPLACE_FAILED", family: OLI_SOURCE_KEY, accountId: a.accountId });
            break;
          }
          rollup.history.rowsPersisted += byAccount.get(a.accountId).length;
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

  if (rollup.cycleId) {
    const rows = await store.listSourceJobs(rollup.cycleId);
    rollup.globalDrained = !rollup.stopped && rows.length > 0 && rows.every((r) => !OPEN.has(stat(r)));
  }
  return rollup;
}
