// Data Sync Center -- SOURCE-level controls (Scheduler v2 durable model).
//
// GET   : the source cards for both buckets + the read-only dashboard-readiness summary.
// PATCH : pause/resume ONE source (source_controls). Pause stops NEW source exports only; durable history,
//         coverage, snapshots and every LKG report snapshot are preserved (nothing here can delete them).
// POST  : "Sync missing data" for one bucket -- ONE bounded coverage-driven orchestration run (<=5-account
//         stable batches; already-proven historical coverage is NEVER re-exported; paused sources plan zero
//         exports). Rate-limited and audited. NOTE: the durable-model migration is PREPARED-UNAPPLIED; until
//         it is applied the GET reads report schema-missing markers and POST fails closed on the first
//         durable write -- this endpoint enables nothing by itself and creates no schedule.
//
// PUBLICATION RECOVERY WP10b -- THE explicit, owner-approved PAID SYNC action (the dashboard refresh=1 of every
// route-owned live report is now read-only). POST is a TWO-STEP contract (PROJECT_GUIDANCE sections 2 + 4):
//   1. PREVIEW -- body { bucket, sourceKey, refreshMode?, preview: true }: ZERO writes, ZERO DataDoe. Returns the TOKEN
//      ESTIMATE computed by the SAME zero-DataDoe planners the runtime executes over the SAME durable evidence
//      (lib/server/sync/paid-sync-estimate.js: planBucketSourceSync + the frozen tranche pricing for Order Line Items /
//      Product Catalog / the whole bucket, planCampaignAdsRegionRun + its bisection fallback for Campaign Ads, the exact
//      fba-plan plan for the FBA cards) -- EXPECTED (cache-aware), WORST CASE (every planned chunk / gap export / weekly
//      slice / single-seller isolation / Ads bisection / the release Catalog) and the APPROVED hard ceiling separately,
//      with the per-create price + assumptions -- which route-owned reports the card refreshes, and a signed
//      confirmationToken bound to (admin, bucket, card, refresh mode, approved ceiling, server as-of D-1, the ONE
//      operation slot + its head cycle + its persisted spend baseline; expires). A card whose planner cannot run
//      read-only is NOT executable (typed reason, no token) -- never a fabricated low estimate.
//   2. EXECUTE -- the SAME body + confirmationToken. Without a valid token: 428 (the estimate attached, NO token -- a
//      token only ever comes from an explicit preview). Before ANY runtime / audit / DataDoe work every slice
//      re-proves: the server as-of still equals the token's (else 409 PAID_SYNC_ASOF_CHANGED), the token still drives
//      the SAME operation (else 409 PAID_SYNC_OPERATION_CHANGED / _FINISHED), and DEBITS the approval cumulatively
//      from the PERSISTED spend of the bound cycle(s) (sync_source_jobs.create_export_count). The remaining approval
//      is ENFORCED where creates happen: the bucket-sync approval gate + frozen tranche reservation (OLI / Catalog /
//      whole bucket), the release Catalog gate (runReleaseSlice), the Campaign Ads create caps (guardedCreate refuses
//      BEFORE the POST), and the FBA plan cost vs min(bucket ceiling, remaining approval). Each accepted slice returns
//      a continuationToken (same nonce / ceiling / expiry, now recording the cycle it runs on) for the next poll.
//   CAMPAIGN ADS (WP10b re-verify P1 fix): the Ads phase opens no sync cycle, so its spend has no persisted per-create
//      count -- it is carried in the signed token (`sp`). To make that chain impossible to rewind, the token also carries
//      an HMAC-bound Ads slice sequence (`aq`: 0 on the start token, +1 on every continuation issued after an Ads slice)
//      and every Ads slice first claims a DURABLE SINGLE-USE RECEIPT for (nonce, aq) -- an insert-if-absent into the
//      existing public.audit_log with a deterministic primary key -- BEFORE any DataDoe create. A replayed start /
//      older continuation token, or a concurrent duplicate, finds its step consumed -> 409 PAID_SYNC_TOKEN_CONSUMED with
//      ZERO runner calls. The OLI / Catalog / whole-bucket / release / FBA debits stay on PERSISTED durable counts, so
//      their poll-retry semantics are unchanged (a retried token re-reads the same durable spend).
// Every publication stays on the fenced publisher (priority release / fba-plan release); nothing here writes a report
// row directly.

import {
  assertAdmin, getDashboardAccess, insertAuditLog, getSourceControls, getSourceRunStatuses, setSourceControl, getAccountDirectoryRows, getAccountOliQualityCounts,
  getSourceCoverageWindows, getSourceExportCache, getSourceExportCacheMeta, getSourceSnapshot, listSourceBatchMembership, getSourceTrancheBudget,
  getSyncCycleByBucketDate, getSyncSourceJobs, getRecentSyncCycleIds, getSyncSourceJobsWithMeta, getSyncSourceJobOwnersForCycle,
  getPriorityCatalogReservation, getDailyAdsCoverage,
  // WP10b re-verify P1: the durable single-use receipt per Campaign-Ads slice (audit_log insert-if-absent; never swallows).
  claimPaidSyncReceipt,
} from "../../lib/server/supabase.js";
import { primaryOrganizationFingerprint, getDataDoeConnections, resolveDataDoeAccountIds } from "../../lib/server/datadoe-connections.js";
import { shapeSourceCards, dashboardReadinessSummary, CARD_BUCKETS } from "../../lib/server/sync/source-status.js";
import { sourceRegistryEntry } from "../../lib/server/sync/source-registry.js";
import { buildBucketSourceSyncRuntime } from "../../lib/server/sync/source-bucket-sync-runtime.js";
import { validateSourceSyncRequest, runReleaseSlice, ORCHESTRATED_SOURCE_KEYS, SOURCE_DASHBOARD_DEPENDENCIES } from "../../lib/server/sync/source-sync-operation.js";
// WP10b paid-sync contract: the signed confirmation token + its ONE-operation binding + which reports each card refreshes.
import {
  issuePaidSyncConfirmation, verifyPaidSyncConfirmation, paidSyncConfirmationKey, paidSyncOperationBinding, routeOwnedReportsForPaidSyncCard,
  ROUTE_OWNED_LIVE_REPORT_KEYS, PAID_SYNC_CONFIRMATION_TTL_MS, paidSyncAdsReceiptId,
} from "../../lib/server/report-store.js";
// WP10b fix: the read-only planners (the SAME ones the runtime executes) + the persisted-spend ledger.
import {
  planSourceSyncPaidExposure, planCampaignAdsPaidExposure, releaseCatalogExposure, persistedCycleSpend, tokenCostForSourceKey, PAID_TOKENS_PER_CREATE,
} from "../../lib/server/sync/paid-sync-estimate.js";
import { CAMPAIGN_ADS_TOKENS_PER_CREATE } from "../../lib/server/sync/scheduled-campaign-ads-runner.js";
import { isFbaOperationSource, resolveFbaPlanScope, planFbaBucketCost, buildFbaBucketPlan, fbaBucketAccounts, advanceFbaPlanBucket, fbaServerCeiling, fbaCycleBucket, fbaInventoryAsOf } from "../../lib/server/sync/fba-plan-operation.js";
// The ONE ASIN->Campaign cutover authority: reject a forged action on the retired ads grain at the API BOUNDARY,
// after auth + source-key parse, BEFORE any runtime / preflight / coverage / discovery / control-or-audit write.
import { isAdsRegistryKeyRetired } from "../../lib/server/active-ads-source.js";

export const config = { maxDuration: 60 };

// Production collaborators, injectable for narrowly-scoped API-boundary tests (the established handler(req,res,deps)
// pattern). The default export wires exactly these; authorization + production imports are never weakened.
const DEFAULT_DEPS = Object.freeze({
  getDashboardAccess, assertAdmin, insertAuditLog, getSourceControls, getSourceRunStatuses, setSourceControl,
  getAccountDirectoryRows, getAccountOliQualityCounts, primaryOrganizationFingerprint, buildBucketSourceSyncRuntime,
  isAdsRegistryKeyRetired,
  // WP10b paid-sync preview + execute-binding readers (read-only, ZERO DataDoe) + the confirmation key + the clock.
  getSourceCoverageWindows, getSourceExportCache, getSourceExportCacheMeta, getSourceSnapshot, listSourceBatchMembership, getSourceTrancheBudget,
  getSyncCycleByBucketDate, getSyncSourceJobs, getRecentSyncCycleIds, getSyncSourceJobsWithMeta, getSyncSourceJobOwnersForCycle,
  getPriorityCatalogReservation, getDailyAdsCoverage,
  getDataDoeConnections, resolveDataDoeAccountIds,
  paidSyncConfirmationKey: () => paidSyncConfirmationKey(), now: () => Date.now(),
  // WP10b re-verify P1: the Campaign-Ads slice receipt (a durable insert-if-absent, claimed before any Ads create).
  claimPaidSyncReceipt,
});
// A collaborator from the injected deps, else the production one (a boundary test injects only what it exercises).
const depOf = (deps, name) => (deps && deps[name] != null ? deps[name] : DEFAULT_DEPS[name]);

// ---------------------------------------------------------------------------------------------------------------------
// WP10b PAID-SYNC PREVIEW (pure over injected readers; ZERO writes, ZERO DataDoe).
// ---------------------------------------------------------------------------------------------------------------------
const FBA_BUCKET_TOKEN_CEILING = Object.freeze({ us: 30, "non-us": 70 }); // per-bucket share of the 80-token daily FBA ceiling
// P3-6: the readable message on every control-lease contention response (409 lease lost / 423 lease held). It never
// claims "nothing was spent": a slice may have fetched before it met the contention (the fetch is kept durably).
const CONTENTION_MESSAGE = "Another operation currently holds the dashboard publish controls, so this step could not publish; nothing was overwritten and saved data is preserved. Retry shortly -- what this operation already fetched is kept and reused.";
// P3-6: the readable top-level error + message for a runtime's typed pre-I/O refusal (runSourceCardAction / run return
// { refused:true, code, message } BEFORE any preflight / DataDoe / write -- so nothing was spent).
const refusalText = (r) => ({
  error: S5(r && r.code) || "SOURCE_SYNC_REFUSED",
  message: (S5(r && r.message) || "This source sync was refused before it started.") + " Nothing was spent by this request.",
});
const S5 = (v) => (v == null ? "" : String(v));
const TERMINAL_CYCLE = new Set(["succeeded", "partial", "failed"]);

/**
 * The ONE operation a paid-sync card drives, resolved SERVER-SIDE from the clock (never from the body): the as-of
 * (D-1 UTC), and the operation slot = the (cycle bucket, cycle date) the runtime opens/continues -- the bucket's
 * (bucket, today) source-sync cycle (OLI / Catalog / Campaign Ads release / whole bucket) or the dedicated
 * (bucket-fba, D-1) fba-plan cycle (FBA cards).
 */
export function paidSyncOperationContext({ bucket, sourceKey = null, nowMs }) {
  const today = new Date(Number(nowMs)).toISOString().slice(0, 10);
  const asOf = new Date(Number(nowMs) - 86400000).toISOString().slice(0, 10);
  const fba = !!(sourceKey && isFbaOperationSource(sourceKey));
  const cycleBucket = fba ? fbaCycleBucket(bucket) : bucket;
  const cycleDate = fba ? fbaInventoryAsOf(Number(nowMs)) : today;
  return {
    today, asOf, fba, cycleBucket, cycleDate, operationKey: cycleBucket + "/" + cycleDate,
    orchestrated: !!(sourceKey && ORCHESTRATED_SOURCE_KEYS.includes(sourceKey)), ads: sourceKey === "ads-campaign-date",
  };
}

// Which read-only planner prices a card (or refuses it typed). Cycle-cache families run the per-tranche report
// composition, whose plan needs live DataDoe discovery: no read-only planner -> not paid-syncable from here.
export function paidSyncCardKind(sourceKey) {
  if (!sourceKey) return { kind: "source-sync" }; // the whole bucket: the durable OLI / Catalog / FBA-snapshot families
  if (isFbaOperationSource(sourceKey)) return { kind: "fba" };
  if (sourceKey === "ads-campaign-date") return { kind: "ads" };
  const entry = sourceRegistryEntry(sourceKey);
  if (entry.storage === "durable-history" || entry.storage === "durable-snapshot") return { kind: "source-sync" };
  if (entry.storage === "durable-ads") return { kind: "none", reason: "durable-ads-architecture" };
  return { kind: "none", reason: "planner-not-read-only" };
}

const estimatorReaders = (deps) => ({
  readSourceControls: () => depOf(deps, "getSourceControls")(),
  readCoverage: (args) => depOf(deps, "getSourceCoverageWindows")(args),
  readSnapshot: (args) => depOf(deps, "getSourceSnapshot")(args),
  readBatchMembership: (family) => depOf(deps, "listSourceBatchMembership")(family),
  getBudget: (args) => depOf(deps, "getSourceTrancheBudget")(args),
  getExportCacheMeta: (hash) => depOf(deps, "getSourceExportCacheMeta")(hash),
  readRecentSyncCycleIds: (cycleBucket, since) => depOf(deps, "getRecentSyncCycleIds")(cycleBucket, since),
  readSyncSourceJobsWithMeta: (cycleId) => depOf(deps, "getSyncSourceJobsWithMeta")(cycleId),
  readSyncSourceJobOwnersForCycle: (cycleId) => depOf(deps, "getSyncSourceJobOwnersForCycle")(cycleId),
  getCoverage: (accountId, grain) => depOf(deps, "getDailyAdsCoverage")(accountId, grain),
});

// The operation slot's CURRENT head cycle + its persisted source jobs (read-only). Throws on an unreadable state.
async function readOperationSlot(ctx, deps) {
  const head = await depOf(deps, "getSyncCycleByBucketDate")(ctx.cycleBucket, ctx.cycleDate);
  if (!head || !head.id) return { head: null, jobs: [] };
  const jobs = await depOf(deps, "getSyncSourceJobs")(head.id);
  if (!Array.isArray(jobs)) throw new Error("source jobs read malformed");
  return { head, jobs };
}

// The bucket's PRIMARY accounts from the durable account directory (the same filter the status cards use).
function bucketDirectoryAccounts(directoryRows, bucket) {
  return (directoryRows || [])
    .filter((r) => r && S5(r.sync_bucket) === bucket && r.account_id && !S5(r.account_id).includes(":"))
    .map((r) => ({ accountId: S5(r.account_id), country: S5(r.marketplace_country_code || r.country).trim(), currency: r.currency || null, name: r.name || null }));
}

// Which route-owned live reports ONE card refreshes: DIRECTLY in the same card operation (published through the
// fenced publisher: the priority release for the orchestrated OLI / Catalog / Campaign-Ads cards, the fba-plan
// operation for the FBA cards) vs VIA the zero-export fenced routes / reconcilers on their next pass. Manual-paid
// insight reports are never counted here (they keep their own report Refresh; not-applicable for publication).
export function paidSyncCardRefreshes(sourceKey) {
  const key = S5(sourceKey);
  const direct = key && SOURCE_DASHBOARD_DEPENDENCIES[key] ? [...SOURCE_DASHBOARD_DEPENDENCIES[key].reports]
    : (key && isFbaOperationSource(key) ? ["fba-plan"] : []);
  const dependents = key ? routeOwnedReportsForPaidSyncCard(key) : [...ROUTE_OWNED_LIVE_REPORT_KEYS];
  return {
    direct: [...direct].sort(),
    viaRoutes: dependents.filter((k) => !direct.includes(k)).sort(),
    manualPaid: "not-applicable (manual-paid insight reports keep their own paid Refresh and are never counted as published)",
  };
}

/// The FBA plan exposure (fba-plan operation cards): the SAME batched plan + durable-cache adoptability the operation
// uses (planFbaBucketCost; ZERO creates), over the durable directory's bucket accounts, against the dedicated fba-plan
// cycle's PERSISTED state. EXPECTED = the plan cost (cache-aware); WORST CASE = every planned batch request not yet
// claimed in the cycle (one premium create each, cache ignored); a terminal cycle is a publish-only pass (zero creates).
// Read-only.
async function fbaPaidSyncEstimate({ bucket, directoryRows, deps, ctx, head, headJobs }) {
  const hardCeiling = FBA_BUCKET_TOKEN_CEILING[bucket];
  const base = {
    basis: "fba-plan-exact", bucket, hardCeilingTokens: hardCeiling, tokensPerCreate: PAID_TOKENS_PER_CREATE,
    enforcement: "the fba-plan operation refuses with zero creates when its remaining new-create cost exceeds min(bucket ceiling, approved ceiling); every slice first debits the cycle's PERSISTED creates and refuses (zero creates) when debited + remaining cost would exceed the approval",
    assumptions: [
      "FBA Inventory Health + AWD Listings are premium: 5 tokens per export; at most 5 marketplace-safe sellers per export (default batching, no overflow split from this card).",
      "A request already fetched into the durable export cache is adopted at 0 tokens (expected); the worst case ignores the cache.",
      "One create per canonical batch request per cycle (claimed durably); a failed batch is never re-created in the same cycle.",
      // WP10b known limit (P2, pre-existing; acquisition deliberately untouched): stated so the approval is never over-read.
      "The approval is checked against the cache-aware PLAN cost before the fba-plan operation runs (and again on every slice); inside the fetch, creates are bounded to one per canonical request hash, with no separate per-create token ceiling -- a request counted as cached (0 tokens) that is no longer adoptable at fetch time is still created once, bounded by the worst case shown.",
    ],
  };
  const zero = (extra) => ({ ...base, exportBatches: 0, expectedCreates: 0, expectedTokens: 0, worstCaseCreates: 0, worstCaseTokens: 0, ...extra });
  const bucketAccounts = fbaBucketAccounts(bucketDirectoryAccounts(directoryRows, bucket).filter((a) => a.country), bucket);
  if (!bucketAccounts.length) return zero({ accounts: 0, note: "no-bucket-accounts" });
  if (head && TERMINAL_CYCLE.has(S5(head.status))) return zero({ accounts: bucketAccounts.length, note: "fba-plan cycle terminal: a publish-only pass (zero creates)" });
  const connections = depOf(deps, "getDataDoeConnections")();
  const scope = await resolveFbaPlanScope({
    accounts: bucketAccounts, connections, asOfArg: null, maxBlocked: 2, ceiling: fbaServerCeiling(),
    readers: { resolveDataDoeAccountIds: depOf(deps, "resolveDataDoeAccountIds"), getSourceCoverageWindows: depOf(deps, "getSourceCoverageWindows") },
  });
  if (!scope.asOf) return zero({ accounts: bucketAccounts.length, note: "no-durable-oli-coverage (the operation stops before any create)" });
  const { plan, cost } = await planFbaBucketCost({ bucketAccounts, connections, asOf: scope.asOf, inventoryAsOf: ctx.cycleDate, getSourceExportCache: depOf(deps, "getSourceExportCache") });
  const worst = fbaUnclaimedPlanCost(plan, headJobs);
  return {
    ...base, accounts: bucketAccounts.length, asOf: scope.asOf, inventoryAsOf: ctx.cycleDate,
    exportBatches: Array.isArray(plan && plan.sourceJobs) ? plan.sourceJobs.length : 0,
    expectedCreates: Math.min(Number(cost && cost.creates) || 0, worst.creates), expectedTokens: Math.min(Number(cost && cost.tokens) || 0, worst.tokens),
    worstCaseCreates: worst.creates, worstCaseTokens: worst.tokens,
  };
}

// The FBA plan's batch requests NOT yet claimed in the dedicated cycle (create_export_count 0), registry-priced: the
// most this cycle can still create (one create per canonical hash; a claimed hash is never re-created).
function fbaUnclaimedPlanCost(plan, cycleJobs) {
  const claimed = new Set((cycleJobs || []).filter((j) => Number(j && (j.create_export_count ?? j.createExportCount) || 0) > 0).map((j) => S5(j.request_hash ?? j.requestHash)));
  const seen = new Set();
  let creates = 0; let tokens = 0;
  for (const j of (plan && plan.sourceJobs) || []) {
    const h = S5(j && (j.requestHash ?? j.request_hash));
    if (!h || seen.has(h) || claimed.has(h)) continue;
    seen.add(h);
    creates += 1; tokens += tokenCostForSourceKey(j.sourceKey ?? j.source_key);
  }
  return { creates, tokens };
}

const ENFORCEMENT_TEXT = {
  "source-sync": "the runtime freezes the exact per-cycle create/token budget (one create per canonical request hash; the reservation RPC refuses beyond it) and, with this approval, refuses with ZERO creates any step whose remaining frozen exposure plus the release Catalog reserve exceeds the approval still unspent (debited from the cycle's PERSISTED creates on every slice); the release Catalog is gated the same way",
  ads: "every region is planned before any create; a plan whose batches exceed the remaining approval is refused with ZERO creates, and every Campaign Ads create (batch, bisection split, page) passes a combined cap derived from the remaining approval BEFORE its POST; the release Catalog is gated like the source-sync cards",
};
const ASSUMPTIONS_TEXT = {
  "source-sync": [
    "DataDoe pricing: standard source = 2 tokens per export (Order Line Items, Product Catalog), premium = 5 (FBA Inventory Health snapshot) -- the registry token class.",
    "The plan is the runtime's own: <=5 sellers per OLI export over the stable durable batch membership, one export per contiguous missing window (<=441-day chunks), the 7-day rolling refresh re-exported, truncation-proven sellers re-sliced weekly and readiness-rejected sellers peeled off solo (resolved from the same durable evidence the runtime reads).",
    "Expected spend excludes requests with a valid durable export-cache entry (0 tokens); the worst case assumes every planned request creates once.",
    "An export returning exactly the 50,000-row cap is never persisted as complete; its weekly re-slice runs on a LATER operation that needs its own confirmation (shown as followOnSplit, not approved here).",
    "Accounts come from the durable account directory; if live discovery at execute time plans more, the step is refused with zero creates and a fresh estimate.",
  ],
  ads: [
    "Campaign Ads is a standard DataDoe source: 2 tokens per create; <=5 sellers per batch; never-covered accounts use the 56-day initial window in their own batches.",
    "Every routed account is assumed Amazon-Ads compatible (the zero-token compatibility probe is a DataDoe call, so the preview skips it) -- an upper bound.",
    "Worst case adds the bisection fallback: a create-time rejection splits a batch down to single sellers, bounded by one extra create per pending seller.",
    // WP10b P3-2: pagination (a page returning exactly the 50,000-row cap triggers one more create for the next page).
    "Pagination creates beyond the planned exports are not included in the worst case; the approval caps them (every page create passes the same pre-POST cap) and a refused page leaves the window uncovered, never complete.",
  ],
};

// Build the preview: estimate (expected / worst case / approved ceiling, per-create price, assumptions) + refreshes + the
// last run's spent/ceiling + (only when executable and asked for) a signed confirmation token bound to the operation.
async function buildPaidSyncPreview({ userId, bucket, sourceKey, refreshMode, deps, key, now, issueToken = true }) {
  const ctx = paidSyncOperationContext({ bucket, sourceKey, nowMs: now });
  const refreshes = paidSyncCardRefreshes(sourceKey);
  const notExecutable = (estimate, howToConfirm) => ({
    bucket, sourceKey: sourceKey || null, refreshMode, executable: false, reason: estimate.unavailable, estimate, refreshes,
    operation: { key: ctx.operationKey, asOf: ctx.asOf },
    confirmationToken: null, approvedMaxTokens: null, expiresAt: null, confirmationUnavailable: !key, howToConfirm,
  });
  // FAIL CLOSED: without the durable account directory no honest estimate exists -> no confirmation token is issued.
  let directoryRows;
  try { directoryRows = await depOf(deps, "getAccountDirectoryRows")(); } catch { directoryRows = null; }
  if (!Array.isArray(directoryRows)) {
    return notExecutable({ unavailable: "account-directory-read-failed" }, "The token estimate is unavailable (the account directory could not be read); nothing can be confirmed or spent. Retry shortly.");
  }
  const card = paidSyncCardKind(sourceKey);
  if (card.kind === "none") {
    return notExecutable({ unavailable: card.reason }, card.reason === "planner-not-read-only"
      ? "This source family cannot be priced read-only (its plan needs live DataDoe discovery), so it cannot be paid-synced from this card; nothing can be confirmed or spent."
      : "This family is fetched by the existing durable Ads architecture; it is not paid-syncable from this card.");
  }
  // The ONE operation slot's current state: its head cycle + the PERSISTED spend already on it (the debit baseline).
  let slot;
  try { slot = await readOperationSlot(ctx, deps); } catch { slot = null; }
  if (!slot) return notExecutable({ unavailable: "operation-state-unreadable" }, "The operation state could not be read, so no honest estimate exists; nothing can be confirmed or spent. Retry shortly.");
  const baselineTokens = persistedCycleSpend(slot.jobs).tokens;
  let estimate;
  try {
    if (card.kind === "fba") {
      estimate = await fbaPaidSyncEstimate({ bucket, directoryRows, deps, ctx, head: slot.head, headJobs: slot.jobs });
    } else if (card.kind === "ads") {
      estimate = await planCampaignAdsPaidExposure({ bucket, asOf: ctx.asOf, directoryRows, connections: depOf(deps, "getDataDoeConnections")(), readers: estimatorReaders(deps) });
      if (!estimate.unavailable) estimate = { ...estimate, enforcement: ENFORCEMENT_TEXT.ads, assumptions: ASSUMPTIONS_TEXT.ads };
    } else {
      estimate = await planSourceSyncPaidExposure({ bucket, sourceKey, refreshMode, directoryRows, connections: depOf(deps, "getDataDoeConnections")(), today: ctx.today, nowMs: now, head: slot.head, headJobs: slot.jobs, readers: estimatorReaders(deps) });
      if (!estimate.unavailable) estimate = { ...estimate, enforcement: ENFORCEMENT_TEXT["source-sync"], assumptions: ASSUMPTIONS_TEXT["source-sync"] };
    }
  } catch (e) {
    estimate = { unavailable: "planner-failed", detail: S5(e && e.message).slice(0, 200) };
  }
  if (estimate.unavailable) return notExecutable(estimate, "The token estimate is unavailable (" + estimate.unavailable + "); nothing can be confirmed or spent.");
  // The orchestrated cards also run the priority release, which may create the date's ONE org Product Catalog export
  // (durable reservation): its exposure is part of the approved worst case unless the date's reservation already exists.
  // The Catalog card's own sync IS that export in the normal flow (its release adopts it), so it is not EXPECTED twice.
  if (ctx.orchestrated) {
    let rel;
    try { rel = await releaseCatalogExposure({ asOf: ctx.asOf, getPriorityCatalogReservation: depOf(deps, "getPriorityCatalogReservation") }); }
    catch { return notExecutable({ unavailable: "release-reservation-unreadable" }, "The release Catalog reservation could not be read, so no honest worst case exists; nothing can be confirmed or spent."); }
    const expectedRelease = sourceKey === "product-catalog" ? 0 : rel.reserveTokens;
    estimate = {
      ...estimate, release: { ...rel, expectedTokens: expectedRelease, worstCaseTokens: rel.reserveTokens },
      expectedCreates: estimate.expectedCreates + (expectedRelease ? 1 : 0), expectedTokens: estimate.expectedTokens + expectedRelease,
      worstCaseCreates: estimate.worstCaseCreates + (rel.reserveTokens ? 1 : 0), worstCaseTokens: estimate.worstCaseTokens + rel.reserveTokens,
    };
  }
  let executable = true;
  let reason = null;
  let approvedCeilingTokens = estimate.worstCaseTokens;
  let hardCeilingTokens = estimate.worstCaseTokens;
  if (card.kind === "fba") {
    hardCeilingTokens = estimate.hardCeilingTokens;
    approvedCeilingTokens = Math.min(estimate.worstCaseTokens, hardCeilingTokens);
    // P3-3: a plan whose EXPECTED cost already exceeds the hard bucket ceiling can never run (the operation would refuse
    // it) -- not executable, no token, typed reason.
    if (estimate.expectedTokens > hardCeilingTokens) { executable = false; reason = "fba-plan-exceeds-hard-ceiling"; }
  }
  let lastRun = null;
  if (sourceKey) {
    try {
      const st = await depOf(deps, "getSourceRunStatuses")();
      const row = ((st && st.rows) || []).find((r) => S5(r.source_key ?? r.sourceKey) === sourceKey && S5(r.bucket) === bucket);
      if (row) lastRun = { createsSpent: row.creates_spent ?? 0, tokensSpent: row.tokens_spent ?? 0, createsCeiling: row.creates_ceiling ?? null, tokensCeiling: row.tokens_ceiling ?? null, lastSuccessAt: row.last_success_at || null };
    } catch { lastRun = null; }
  }
  const operation = {
    key: ctx.operationKey, asOf: ctx.asOf, cycleId: slot.head ? S5(slot.head.id) : "", cycleStatus: slot.head ? S5(slot.head.status) : null,
    baselineTokens, previewTerminal: !!(slot.head && TERMINAL_CYCLE.has(S5(slot.head.status))),
  };
  const issued = executable && issueToken
    ? issuePaidSyncConfirmation({ userId, bucket, sourceKey, refreshMode, approvedMaxTokens: approvedCeilingTokens, asOf: ctx.asOf, operation, kind: "start", now, key })
    : null;
  return {
    bucket, sourceKey: sourceKey || null, refreshMode, executable, reason,
    estimate: { ...estimate, hardCeilingTokens, approvedCeilingTokens, lastRun },
    operation: { key: operation.key, asOf: operation.asOf, cycleId: operation.cycleId || null, cycleStatus: operation.cycleStatus, baselineTokens },
    refreshes,
    confirmationToken: issued ? issued.token : null,
    approvedMaxTokens: executable ? approvedCeilingTokens : null,
    expiresAt: issued ? issued.expiresAt : null,
    ttlMinutes: Math.round(PAID_SYNC_CONFIRMATION_TTL_MS / 60000),
    confirmationUnavailable: !key,
    howToConfirm: executable
      ? "Re-POST the same body with confirmationToken to spend DataDoe tokens; each accepted slice returns a continuationToken for the next poll. Without it nothing is spent."
      : "The expected cost exceeds the hard ceiling; this card cannot run until the plan fits. Nothing can be confirmed or spent.",
  };
}

// WP10b (P1 + P2) EXECUTE-TIME binding + cumulative debit (read-only; ZERO writes, ZERO DataDoe). Re-reads the operation
// slot's head, proves the confirmation still drives the SAME operation (paidSyncOperationBinding), and debits the
// approval with the PERSISTED spend of every bound cycle (sync_source_jobs.create_export_count x registry price) minus
// the preview's baseline, plus the Campaign-Ads phase spend carried in the signed continuation token (strictly linear:
// every Ads-phase token is single-use through its durable receipt, so an older, lower `sp` can never be replayed into an
// Ads slice). Returns { ok:true, remainingTokens, debitedTokens, boundCycleId, jobsByCycle } | { ok:false, status, error,
// message }.
async function paidSyncDebit({ claims, ctx, deps, adsSpentTokens }) {
  let head;
  try { head = await depOf(deps, "getSyncCycleByBucketDate")(ctx.cycleBucket, ctx.cycleDate); }
  catch { return { ok: false, status: 503, error: "PAID_SYNC_OPERATION_UNVERIFIABLE", message: "The operation state could not be read, so the approved spend cannot be re-proven; nothing was spent. Retry shortly." }; }
  const binding = paidSyncOperationBinding({ claims, head });
  if (!binding.ok) return { ok: false, status: 409, error: binding.code, message: binding.message };
  const jobsByCycle = {};
  let spentTokens = 0;
  for (const cycleId of binding.cycleIds) {
    let jobs;
    try { jobs = await depOf(deps, "getSyncSourceJobs")(cycleId); } catch { jobs = null; }
    if (!Array.isArray(jobs)) return { ok: false, status: 503, error: "PAID_SYNC_OPERATION_UNVERIFIABLE", message: "The operation's persisted spend could not be read; nothing was spent. Retry shortly." };
    jobsByCycle[cycleId] = jobs;
    spentTokens += persistedCycleSpend(jobs).tokens;
  }
  const debitedTokens = Math.max(0, spentTokens - claims.baselineTokens) + Number(adsSpentTokens || 0);
  return { ok: true, head, boundCycleId: binding.boundCycleId, jobsByCycle, spentTokens, debitedTokens, remainingTokens: claims.approvedMaxTokens - debitedTokens };
}

const RATE = new Map();
// A completed manual sync is a POLLED CONTINUATION flow (the UI re-POSTs the same operation until terminal), so
// the per-user window must admit a full multi-slice run; 30/10min still bounds abuse hard (each slice is itself
// deadline-bounded and audited).
function allowManualRun(userId, now = Date.now()) {
  const hits = (RATE.get(userId) || []).filter((time) => now - time < 10 * 60_000);
  if (hits.length >= 30) return false;
  hits.push(now);
  RATE.set(userId, hits);
  return true;
}
// WP10b P3-5: a SEPARATE, equally hard per-user budget for EXECUTE polls that carry a VERIFIED continuation token (valid
// HMAC, kind "cont", same admin / bucket / card / mode, unexpired). The UI polls up to 40 slices per operation (plus the
// preview + start execute), which the shared 30/10min window could 429 mid-run. This does NOT weaken the abuse bound:
// a continuation token cannot be forged or requested -- the server mints it only after an ACCEPTED execute slice whose
// start token came from a preview, and both of those still draw from the unchanged 30/10min budget; it is bound to ONE
// operation and dies with the original approval (<= 60 min); every continuation is still fully re-verified, re-bound,
// debited (persisted counts / the single-use Ads receipt) and audited -- the limiter was never a spend control; and the
// continuation budget is itself capped (60 per 10 min per user: one full 40-poll operation plus margin). Previews,
// start executes and anything with a missing / invalid / start token keep the original budget.
const CONT_RATE = new Map();
function allowContinuationRun(userId, now = Date.now()) {
  const hits = (CONT_RATE.get(userId) || []).filter((time) => now - time < 10 * 60_000);
  if (hits.length >= 60) return false;
  hits.push(now);
  CONT_RATE.set(userId, hits);
  return true;
}
// Pure classification for the limiter only (the execute path re-verifies authoritatively below): true only for a
// non-preview POST whose confirmationToken verifies as a CONTINUATION for exactly this scope.
function isVerifiedContinuationExecute(body, userId, deps) {
  if (!body || body.preview === true || typeof body.confirmationToken !== "string") return false;
  try {
    const v = verifyPaidSyncConfirmation(body.confirmationToken, {
      userId, bucket: String(body.bucket || ""), sourceKey: body.sourceKey ? String(body.sourceKey) : null,
      refreshMode: body.refreshMode == null ? "normal" : String(body.refreshMode),
      now: depOf(deps, "now")(), key: depOf(deps, "paidSyncConfirmationKey")(),
    });
    return v.ok === true && v.kind === "cont";
  } catch { return false; }
}

function bodyFor(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

async function statusPayload(deps = DEFAULT_DEPS) {
  const { getSourceControls, getSourceRunStatuses, getAccountDirectoryRows, getAccountOliQualityCounts, primaryOrganizationFingerprint, buildBucketSourceSyncRuntime } = deps;
  const [controls, statuses] = await Promise.all([getSourceControls(), getSourceRunStatuses()]);
  // Finding 8: dashboard readiness comes from AUTHORITATIVE per-account durable evidence (coverage /
  // snapshot freshness / per-account Ads windows), gathered per bucket from the account directory --
  // last_status cards remain the quick health summary but never decide readiness. A gathering failure is a
  // TYPED unavailable readiness, never a fabricated "ready" and never a 500 for the whole surface.
  let directoryRows = [];
  try { directoryRows = (await getAccountDirectoryRows()) || []; } catch { directoryRows = []; }
  const runtime = buildBucketSourceSyncRuntime();
  // Org fingerprint for the read-only OLI data-quality summary (never a data change, ZERO DataDoe). Best-effort:
  // absence never breaks the source cards.
  let qualityOrgFp = null;
  try { qualityOrgFp = primaryOrganizationFingerprint(); } catch { qualityOrgFp = null; }
  const cards = {};
  for (const bucket of CARD_BUCKETS) {
    const bucketCards = shapeSourceCards({ bucket, controls: controls.rows, runStatuses: statuses.rows });
    const accounts = directoryRows
      .filter((r) => (r.sync_bucket || "") === bucket && r.account_id && !String(r.account_id).includes(":"))
      .map((r) => ({ accountId: String(r.account_id) }));
    let readiness;
    try {
      readiness = accounts.length
        ? await runtime.gatherDurableReadiness({ bucket, accounts })
        : { unavailable: "no-bucket-accounts" };
    } catch (error) {
      readiness = { unavailable: error?.code || "READINESS_GATHER_FAILED" };
    }
    // Per-account OLI DATA-QUALITY summary (read-only, ZERO DataDoe): explicit-zero non-cancelled units, cancelled
    // audit units, and the latest dimensional coverage date. Computed in PARALLEL and best-effort -- a per-account
    // failure yields an unavailable marker and never breaks or blocks the source cards.
    let oliQuality = [];
    if (qualityOrgFp && accounts.length) {
      oliQuality = await Promise.all(accounts.map(async (a) => {
        try {
          const counts = await getAccountOliQualityCounts({ organizationFingerprint: qualityOrgFp, accountId: a.accountId });
          return { accountId: a.accountId, ...counts };
        } catch (e) {
          return { accountId: a.accountId, unavailable: e?.code || "QUALITY_READ_FAILED" };
        }
      }));
    }
    cards[bucket] = { cards: bucketCards, cardSummary: dashboardReadinessSummary(bucketCards), readiness, oliQuality };
  }
  return {
    buckets: cards,
    reads: { controls: controls.read, runStatuses: statuses.read },
    note: controls.read === "schema-missing"
      ? "The durable source model migration is prepared but not applied; source controls become live after the reviewed migration gate."
      : "Pause stops new source exports only; durable data and last-known-good snapshots are always preserved.",
  };
}

export async function handler(req, res, deps = DEFAULT_DEPS) {
  try {
    const access = await deps.getDashboardAccess(req);
    deps.assertAdmin(access);

    if (req.method === "GET") {
      res.status(200).json(await statusPayload(deps));
      return;
    }

    const body = bodyFor(req);

    if (req.method === "PATCH") {
      const sourceKey = String(body.sourceKey || "");
      try { sourceRegistryEntry(sourceKey); } catch {
        res.status(400).json({ error: "Unknown source." });
        return;
      }
      // ATOMIC ADS CUTOVER -- retired-source refusal at the API BOUNDARY, immediately after the source key is
      // parsed + validated and BEFORE setSourceControl / insertAuditLog / statusPayload (or any other write). A
      // forged PATCH on the retired ASIN grain can never mutate its hidden control. Runtime-level guards remain
      // (SOURCE_ACTION_ADS_ARCHITECTURE + the ads-sync export guard) as defense in depth.
      if (deps.isAdsRegistryKeyRetired(sourceKey)) {
        res.status(409).json({ error: "SOURCE_RETIRED", sourceKey, message: "This source is retained only for rollback and cannot be operated while Campaign Ads is active." });
        return;
      }
      // Finding 8: `paused` must be an ACTUAL boolean. A missing/malformed value must never coerce into a
      // silent resume (false) -- it is a 400 with ZERO writes (no control write, no audit row).
      if (typeof body.paused !== "boolean") {
        res.status(400).json({ error: "body.paused must be a boolean." });
        return;
      }
      const paused = body.paused;
      await deps.setSourceControl({ sourceKey, paused, updatedBy: access.userId });
      await deps.insertAuditLog({
        actorUserId: access.userId,
        action: paused ? "source.paused" : "source.resumed",
        target: { sourceKey },
      });
      res.status(200).json(await statusPayload(deps));
      return;
    }

    if (req.method === "POST") {
      // WP10b P3-5: a verified continuation poll draws from its own capped budget; everything else (previews, start
      // executes, missing / invalid tokens) from the original 30 / 10 min window.
      const continuationPoll = isVerifiedContinuationExecute(body, access.userId, deps);
      if (!(continuationPoll ? allowContinuationRun(access.userId) : allowManualRun(access.userId))) {
        res.status(429).json({ error: "Source sync limit reached. Wait before trying again." });
        return;
      }
      const bucket = String(body.bucket || "");
      if (bucket !== "us" && bucket !== "non-us") {
        res.status(400).json({ error: "Select the US or non-US marketplace bucket." });
        return;
      }
      const onlySourceKey = body.sourceKey ? String(body.sourceKey) : null;
      if (onlySourceKey) {
        try { sourceRegistryEntry(onlySourceKey); } catch {
          res.status(400).json({ error: "Unknown source." });
          return;
        }
      }
      // ATOMIC ADS CUTOVER -- retired-source refusal at the API BOUNDARY, immediately after the source key is
      // parsed + validated and BEFORE runtime construction / preflightEvidence / coverage reads / discovery /
      // audit writes / any DataDoe / token-or-create activity. A forged POST on the retired ASIN grain can never
      // reach the sync path. Runtime-level guards remain (SOURCE_ACTION_ADS_ARCHITECTURE + the ads-sync export
      // guard) as defense in depth.
      if (onlySourceKey && deps.isAdsRegistryKeyRetired(onlySourceKey)) {
        res.status(409).json({ error: "SOURCE_RETIRED", sourceKey: onlySourceKey, message: "This source is retained only for rollback and cannot be operated while Campaign Ads is active." });
        return;
      }

      // ---------------- WP10b EXPLICIT PAID-SYNC CONFIRMATION (preview -> token estimate -> confirm) ----------------
      // BEFORE any runtime construction / preflight / audit / control / DataDoe work: a preview returns the token
      // estimate + refreshes + a signed token and spends NOTHING; an execute POST without a valid, unexpired,
      // scope-bound confirmationToken is refused with the estimate attached but NO token (P3-2: a token only ever comes
      // from an explicit preview:true). Every execute slice (including each continuation poll) re-verifies it.
      const paidRefreshMode = body.refreshMode == null ? "normal" : String(body.refreshMode);
      const paidConfirmKey = depOf(deps, "paidSyncConfirmationKey")();
      const paidNow = depOf(deps, "now")();
      const paidScope = { userId: access.userId, bucket, sourceKey: onlySourceKey, refreshMode: paidRefreshMode };
      const wantsPaidPreview = body.preview === true;
      const paidConfirmation = wantsPaidPreview ? null : verifyPaidSyncConfirmation(body.confirmationToken, { ...paidScope, now: paidNow, key: paidConfirmKey });
      if (wantsPaidPreview || !paidConfirmation.ok) {
        const preview = await buildPaidSyncPreview({ ...paidScope, deps, key: paidConfirmKey, now: paidNow, issueToken: wantsPaidPreview });
        if (wantsPaidPreview) { res.status(200).json({ preview }); return; }
        const reason = paidConfirmation.reason;
        res.status(reason === "unavailable" ? 503 : 428).json({
          error: reason === "missing" ? "PAID_SYNC_CONFIRMATION_REQUIRED" : (reason === "unavailable" ? "PAID_SYNC_CONFIRMATION_UNAVAILABLE" : "PAID_SYNC_CONFIRMATION_INVALID"),
          reason,
          message: "This paid sync spends DataDoe tokens. Review the token estimate and confirm it explicitly (request a preview, then re-POST with its confirmationToken); nothing was spent.",
          preview,
        });
        return;
      }
      const approvedMaxTokens = paidConfirmation.approvedMaxTokens;
      // A refusal of THIS execute (nothing spent by it): the fresh estimate is attached WITHOUT a token -- the admin
      // re-confirms through an explicit preview.
      const refusePaid = async (status, error, message, extra = {}) => {
        res.status(status).json({ error, message, ...extra, preview: await buildPaidSyncPreview({ ...paidScope, deps, key: paidConfirmKey, now: paidNow, issueToken: false }) });
      };
      // P2: the token is bound to the SERVER-resolved as-of (D-1 at issue) and to ONE operation slot. A UTC-midnight
      // roll between preview and execute is a new day's operation -> 409 + re-preview, never a silent new spend.
      const paidCtx = paidSyncOperationContext({ bucket, sourceKey: onlySourceKey, nowMs: paidNow });
      if (paidConfirmation.asOf !== paidCtx.asOf || paidConfirmation.operationKey !== paidCtx.operationKey) {
        await refusePaid(409, paidConfirmation.asOf !== paidCtx.asOf ? "PAID_SYNC_ASOF_CHANGED" : "PAID_SYNC_OPERATION_CHANGED",
          "The data as-of this confirmation approved (" + paidConfirmation.asOf + ") is no longer the server's current as-of (" + paidCtx.asOf + "); review the fresh estimate and confirm again. Nothing was spent by this request.");
        return;
      }
      // P2 + P1: the SAME operation (the slot's head is the cycle this approval drives; a finished one needs a new
      // confirmation) and the CUMULATIVE debit from its PERSISTED spend (every earlier slice's creates count).
      let adsSpentNow = paidConfirmation.adsSpentTokens;
      // The Campaign-Ads slice sequence this request's token occupies (HMAC-bound). It advances by exactly one the moment
      // this request CLAIMS that step's durable receipt (the Ads branch below), so every token issued afterwards names
      // the NEXT step and the consumed one can never be presented again.
      let adsSliceSeqNow = paidConfirmation.adsSliceSeq;
      let paidDebit = await paidSyncDebit({ claims: paidConfirmation, ctx: paidCtx, deps, adsSpentTokens: adsSpentNow });
      if (!paidDebit.ok) { await refusePaid(paidDebit.status, paidDebit.error, paidDebit.message); return; }
      if (paidDebit.remainingTokens < 0) {
        await refusePaid(409, "PAID_SYNC_APPROVAL_EXHAUSTED", "This operation has already spent " + paidDebit.debitedTokens + " tokens against the approved " + approvedMaxTokens + "; confirm a new estimate to continue. Nothing was spent by this request.");
        return;
      }
      // The release Catalog exposure the orchestrated cards must keep in reserve (read-only; unreadable -> fail closed).
      let releaseReserveTokens = 0;
      if (paidCtx.orchestrated) {
        try { releaseReserveTokens = (await releaseCatalogExposure({ asOf: paidCtx.asOf, getPriorityCatalogReservation: depOf(deps, "getPriorityCatalogReservation") })).reserveTokens; }
        catch { await refusePaid(503, "PAID_SYNC_OPERATION_UNVERIFIABLE", "The release Catalog reservation could not be read, so the approved spend cannot be re-proven; nothing was spent. Retry shortly."); return; }
      }
      // The continuation token every accepted slice returns: the SAME nonce / approval / expiry, now RECORDING the cycle
      // this operation runs on (bound at its first execute), the Campaign-Ads phase spend and the Ads slice sequence
      // (unchanged when no Ads slice ran in this request; +1 after one did). null once finished.
      const nextPaidToken = async ({ finished = false } = {}) => {
        if (finished) return null;
        let cycleId = paidDebit.boundCycleId || "";
        if (!cycleId) {
          try {
            const h = await depOf(deps, "getSyncCycleByBucketDate")(paidCtx.cycleBucket, paidCtx.cycleDate);
            if (h && h.id && !S5(h.supersedes_cycle_id ?? h.supersedesCycleId)) cycleId = S5(h.id);
          } catch { cycleId = ""; /* the next poll re-binds from the durable head */ }
        }
        const t = issuePaidSyncConfirmation({
          ...paidScope, approvedMaxTokens, asOf: paidCtx.asOf, kind: "cont",
          operation: { key: paidCtx.operationKey, cycleId, baselineTokens: paidConfirmation.baselineTokens, previewTerminal: paidConfirmation.previewTerminal, adsSpentTokens: adsSpentNow, adsSliceSeq: adsSliceSeqNow },
          nonce: paidConfirmation.nonce, issuedAt: paidConfirmation.issuedAt, expiresAtMs: paidConfirmation.expiresAtMs, key: paidConfirmKey,
        });
        return t ? t.token : null;
      };
      const paidApproval = () => ({ approvedMaxTokens, debitedTokens: paidDebit.debitedTokens, remainingTokens: paidDebit.remainingTokens, releaseReserveTokens });

      // ---------------- FBA Shipment Plan sync (fba-inventory-health / US Listings-AWD) ----------------
      // The FBA source cards run the SHARED, decoupled fba-plan operation core -- the SAME deadline-aware,
      // bounded-resumable pipeline the CLI operator + the automatic GitHub scheduler use (batched marketplace-safe
      // FBA Health/AWD fetch -> durable OLI + Catalog derive -> four-gate CAS publish -> exact live read-back ->
      // ownership backfill -> ALWAYS safe-close). There is NO parallel implementation. ONE bounded slice per POST;
      // the UI re-POSTs the SAME body until phase==="complete". The durable operation identity (the DEDICATED
      // `${bucket}-fba` cycle at server-resolved as-of=D-1) makes every replay -- concurrent poll, retry, or the
      // scheduled fallback -- a zero-create idempotent no-op (never a duplicate export or double-spent token), and
      // an FBA failure NEVER touches Daily Reporting / Brand View (separate cycle namespace + control envelope).
      if (onlySourceKey && isFbaOperationSource(onlySourceKey)) {
        const fbaDeadline = deps.buildBucketSourceSyncRuntime().makeDeadline();
        // Audit BEFORE any execution write, bounded by the same route budget (a duplicate audit row on a retry is
        // harmless; an unaudited execution is not).
        await fbaDeadline.bound("audit-write", (signal) => deps.insertAuditLog({
          actorUserId: access.userId, action: "source.sync.missing", target: { bucket, sourceKey: onlySourceKey, family: "fba-plan" },
        }, { signal }), { write: true });
        const boundedStatusFn = async (dl) => {
          try { return await dl.bound("status-reads", () => statusPayload(deps)); }
          catch (error) { if (error && error.code === "ROUTE_DEADLINE_EXCEEDED") return { unavailable: "ROUTE_DEADLINE_EXCEEDED" }; throw error; }
        };
        const operator = access.userId ? "admin:" + String(access.userId) : "admin:data-sync-center";
        // The reviewed fba-plan RELEASE SEAM wires runtime/publisher/controls/read-back/ownership (the route
        // never touches the publisher composition, the CAS primitive, or the control internals itself).
        const { buildFbaPlanRelease } = await import("../../lib/server/sync/fba-plan-release-composition.js");
        // Round-8 blocker 2: a CRYPTOGRAPHICALLY-UNIQUE token PER HTTP EXECUTION (never derived from
        // operator/bucket). Each bounded slice fully applies -> publishes -> safe-closes -> RELEASES the lease,
        // so successive polls each re-acquire cleanly; two concurrent same-admin+bucket requests get DIFFERENT
        // tokens and contend -- one wins, the other defers WITHOUT altering the winner's controls.
        const { randomUUID } = await import("node:crypto");
        const controlOwnerToken = "route-fba:" + bucket + ":" + randomUUID();
        const release = buildFbaPlanRelease({ operator, ownerToken: controlOwnerToken, controlOperationKey: "route-fba/" + bucket });
        try {
          // Respect an explicit source pause (parity with the OLI path): an admin who paused this FBA source must
          // not have it synced. Fail closed on an unreadable control table (never a silent create).
          const controlsRead = await fbaDeadline.bound("controls-read", () => deps.getSourceControls());
          if (controlsRead && controlsRead.read !== "ok") throw Object.assign(new Error("source controls unavailable (migration/read)"), { status: 503 });
          const pausedSet = new Set((controlsRead.rows || []).filter((r) => r.paused === true).map((r) => r.source_key));
          if (pausedSet.has(onlySourceKey)) {
            // P3-6: a readable top-level error + message (the UI shows "error: message"), the typed operation kept.
            res.status(409).json({ operation: { phase: "sync", ok: false, problems: ["source \"" + onlySourceKey + "\" is paused; resume it before syncing"] }, error: "SOURCE_PAUSED", message: "This source is paused; resume it before syncing. Nothing was spent by this request.", status: await boundedStatusFn(fbaDeadline) });
            return;
          }
          const accounts = await release.loadAccounts();
          if (!accounts.length) { res.status(200).json({ operation: { phase: "sync", ok: false, problems: ["no primary accounts with directory metadata"] }, status: await boundedStatusFn(fbaDeadline) }); return; }

          // The go-live as-of is resolved GLOBALLY (across all accounts), identical to the CLI/scheduler, so the
          // dedicated operation identity is the SAME regardless of which path or bucket triggers it.
          const bucketAccounts = fbaBucketAccounts(accounts, bucket);
          // WP10b P2: the inventory as-of IS the token-bound operation date (== fbaInventoryAsOf at this request's clock).
          const inventoryAsOf = paidCtx.cycleDate;
          const scope = await resolveFbaPlanScope({ accounts: bucketAccounts, connections: release.connections, asOfArg: null, maxBlocked: 2, ceiling: fbaServerCeiling(), readers: release.scopeReaders });
          if (!scope.asOf) { res.status(200).json({ operation: { phase: "sync", ok: false, problems: ["no account has durable OLI coverage; cannot resolve an as-of"] }, status: await boundedStatusFn(fbaDeadline) }); return; }
          if (!bucketAccounts.length) { res.status(200).json({ operation: { phase: "complete", ok: true, published: 0, note: "no-bucket-accounts" }, status: await boundedStatusFn(fbaDeadline) }); return; }
          // Skip the FETCH-only cost plan when the dedicated cycle is already terminal: a publish-only pass has
          // nothing to fetch (no token gate needed). But the batched PLAN (per-account inventory request identities)
          // is ALWAYS required -- the durable-source persist runs on the terminal/publish pass, so we rebuild the plan
          // deterministically (ZERO export, pure) even when the token cost is intentionally null. The route uses
          // default batching (no overflow) for BOTH its fetch and this plan, so the plan's request identities match
          // what this route fetched; the scheduled go-live remains authoritative for any overflow-split seller.
          const existingCycle = await release.runtime.store.getCycleByBucketDate(fbaCycleBucket(bucket), inventoryAsOf).catch(() => null);
          const terminal = existingCycle && ["succeeded", "partial", "failed"].includes(String(existingCycle.status));
          const planned = terminal ? null : await planFbaBucketCost({ bucketAccounts, connections: release.connections, asOf: scope.asOf, inventoryAsOf, getSourceExportCache: release.getSourceExportCache });
          const plan = terminal
            ? buildFbaBucketPlan({ bucketAccounts, connections: release.connections, asOf: scope.asOf, inventoryAsOf })
            : planned.plan;
          // WP10b P1: the cost this pass can still ADD = the plan's non-adoptable requests NOT yet claimed in the
          // dedicated cycle (a claimed hash is never re-created; its spend is already DEBITED from the persisted
          // create_export_count). Debited + this cost must fit the approval, else refuse with ZERO creates.
          const cycleJobs = existingCycle && existingCycle.id ? (paidDebit.jobsByCycle[S5(existingCycle.id)] || []) : [];
          const unclaimed = terminal ? { creates: 0, tokens: 0 } : fbaUnclaimedPlanCost(planned.plan, cycleJobs);
          const cost = terminal ? null : { ...planned.cost, creates: Math.min(Number(planned.cost.creates) || 0, unclaimed.creates), tokens: Math.min(Number(planned.cost.tokens) || 0, unclaimed.tokens) };
          if (cost && paidDebit.debitedTokens + cost.tokens > approvedMaxTokens) {
            await refusePaid(409, "PAID_SYNC_SCOPE_CHANGED", "The FBA plan still needs " + cost.tokens + " tokens but only " + paidDebit.remainingTokens + " of the approved " + approvedMaxTokens + " remain; review the fresh estimate and confirm again. Nothing was created by this request.", { approval: paidApproval() });
            return;
          }
          const includedIds = scope.included.filter((id) => bucketAccounts.some((a) => a.accountId === id));
          // Per-bucket share of the 80-token daily ceiling (scheduler parity); WP10b: the admin-approved ceiling of the
          // confirmation token can only LOWER it (the operation refuses with zero creates when its plan costs more).
          const maxTokens = Math.min(FBA_BUCKET_TOKEN_CEILING[bucket], approvedMaxTokens);

          const result = await advanceFbaPlanBucket({
            bucket, asOf: scope.asOf, inventoryAsOf, includedIds, bucketAccounts, plan, cost, maxTokens,
            runtime: release.runtime, publisher: release.publisher, controls: release.controls,
            readbackLive: release.readbackLive, ownershipBackfill: release.ownershipBackfill,
            verifyLease: release.verifyLease,
            // ZERO-EXPORT durable FBA source persist (backstop enabler): lands source_snapshots(fba-inventory-health)
            // from the just-fetched cache. The `plan` above carries the per-account inventory request identities it
            // reuses -- required on the terminal/publish pass too (the scheduled go-live is authoritative overall).
            persistDurableFbaSnapshots: release.persistDurableFbaSnapshots,
            trigger: "vercel", deadlineMs: fbaDeadline.deadlineMs, reserveMs: fbaDeadline.reserveMs, outOfTime: fbaDeadline.outOfTime,
          });
          // P1-D: a lost control-lease fence (write-boundary or heartbeat) is a TYPED RETRYABLE 409, never a
          // generic 500 or a silent continuation.
          if (result.leaseLost === true || result.phase === "contention") {
            res.status(409).json({ operation: { phase: "contention", ok: false, retryable: true, status: "CONTROL_LEASE_LOST", problems: result.problems || [] }, result: { fbaPlan: { operationId: result.operationId } }, error: "CONTROL_LEASE_LOST", message: CONTENTION_MESSAGE, status: await boundedStatusFn(fbaDeadline) });
            return;
          }
          const operation = result.phase === "complete" && result.ok === true
            ? { phase: "complete", ok: true, published: result.published, readback: result.readback, accounts: result.accounts, batches: result.batches, creates: result.creates, tokens: result.tokens, blocked: result.blocked }
            : result.continuationRequired === true
              ? { phase: result.phase, continuationRequired: true, published: result.published, accounts: result.accounts, batches: result.batches, creates: result.creates, tokens: result.tokens }
              : { phase: result.phase, ok: false, problems: result.problems || ["typed failure"], published: result.published };
          // Surface the ZERO-EXPORT durable backstop disposition (OBSERVABLE, never silent) alongside the fba-plan
          // operation result -- a not-ok backstop does NOT fail the sync (publication + LKG stand) but is reported.
          const durableFba = result.durableFba
            ? { ok: result.durableFba.ok === true, expected: result.durableFba.expected, persisted: result.durableFba.persisted, reason: result.durableFba.reason || null, needsNextCycle: (result.durableFba.needsNextCycle || []).length }
            : null;
          res.status(200).json({ operation, result: { fbaPlan: { operationId: result.operationId, asOf: scope.asOf, includedAccounts: includedIds.length, blockedAccounts: result.blocked, durableFba } }, approval: paidApproval(), continuationToken: await nextPaidToken({ finished: operation.phase === "complete" && operation.ok === true }), status: await boundedStatusFn(fbaDeadline) });
          return;
        } catch (error) {
          // Safety net: the core ALWAYS safe-closes in its own finally, but a throw before/around a pass could
          // leave gates open -- close them explicitly (idempotent) through the same release seam before surfacing.
          try { await release.controls.close(); } catch { /* the original error is surfaced below */ }
          // P1-D: a control-lease HELD/LOST is a TYPED RETRYABLE contention (423 Locked -- another operation owns
          // the global control plane), never a generic 500. The client retries; nothing was overwritten.
          const msg = String(error?.message || "fba sync failed");
          if (/CONTROL_LEASE_HELD|CONTROL_LEASE_LOST/.test(msg)) {
            res.status(423).json({ operation: { phase: "contention", ok: false, retryable: true, status: "CONTROL_LEASE_HELD", problems: [msg] }, error: "CONTROL_LEASE_HELD", message: CONTENTION_MESSAGE });
            return;
          }
          res.status(error?.status || 500).json({ operation: { phase: "sync", ok: false, problems: [msg] } });
          return;
        }
      }

      // Finding 8 + round-5 blocker 3: the FAIL-CLOSED EVIDENCE PREFLIGHT runs BEFORE the endpoint's FIRST
      // write -- including the audit row -- and now sweeps EVERY read execution needs (controls, discovery,
      // coverage, snapshot hydration/integrity, Ads coverage, Ads metrics, OLI history, membership,
      // settings, rollout). Any failure refuses typed with ZERO writes; only a passing preflight is audited
      // and executed, and execution consumes the ONE memoized bundle (no repeated discovery/reads).
      // Round-5 blocker 4: the ONE route-owned deadline is created BEFORE preflight, so preflight time
      // counts against the same route budget that bounds execution.
      const runtime = deps.buildBucketSourceSyncRuntime();
      const deadline = runtime.makeDeadline();
      const preflight = await runtime.preflightEvidence({ bucket, sourceKey: onlySourceKey, deadline });
      // WP10b P2: execution runs on the preflight's OWN day (the cycle date; as-of = D-1). It must be the token-bound
      // day, else a UTC midnight rolled between the binding check and here -- refuse BEFORE the audit (zero writes).
      if (!preflight || preflight.today !== paidCtx.today) {
        await refusePaid(409, "PAID_SYNC_ASOF_CHANGED", "The server's day rolled over while this paid sync was being prepared; review the fresh estimate and confirm again. Nothing was spent by this request.");
        return;
      }
      // Round-6 fix 4: the AUDIT WRITE is bounded by the SAME route budget and carries the route's
      // AbortSignal into the real HTTP wrapper. A before-request expiry proves zero audit rows; an
      // IN-FLIGHT expiry means the audit row MAY have committed (commitUnknown) -- in both cases the
      // action is refused typed BEFORE any execution write (a duplicate audit row on retry is harmless;
      // an unaudited execution is not).
      await deadline.bound("audit-write", (signal) => deps.insertAuditLog({
        actorUserId: access.userId,
        action: "source.sync.missing",
        target: { bucket, sourceKey: onlySourceKey },
      }, { signal }), { write: true });
      // Finding 4: every registered source card action routes to its REAL architecture (bucket sync /
      // single-family tranche composition / the durable-Ads runner) or refuses TYPED; finding 3: the runtime
      // enforces a real serverless deadline with reserve headroom and returns a typed-resumable rollup.
      //
      // ORCHESTRATED sources (OLI / ads-campaign-date / product-catalog) get the FULL trusted flow: sync the ONE
      // selected source, then derive + publish every affected dashboard from the SAME persisted evidence via the
      // shared release engine (open controls -> publish via freshness CAS -> ALWAYS safe-close per slice -> exact
      // live read-back). One request runs ONE bounded slice; `operation.continuationRequired` tells the UI to
      // re-POST the SAME body until `operation.phase === "complete"` -- no duplicate creates on continuation
      // (one-create-per-hash + coverage skip + CAS make every replay idempotent).
      // Round-6 fix 4: the response-status reads share the SAME route budget. An expired budget degrades
      // the refresh to a TYPED unavailable marker -- the action result itself is still reported honestly.
      const boundedStatusFn = async (dl) => {
        try {
          return await dl.bound("status-reads", () => statusPayload(deps));
        } catch (error) {
          if (error && error.code === "ROUTE_DEADLINE_EXCEEDED") return { unavailable: "ROUTE_DEADLINE_EXCEEDED" };
          throw error;
        }
      };
      let operation = null;
      let result = null;
      if (onlySourceKey && ORCHESTRATED_SOURCE_KEYS.includes(onlySourceKey)) {
        const remainingMs = () => Math.max(1000, deadline.deadlineMs - deadline.reserveMs - Date.now());
        const requestedPhase = body.phase == null ? "sync" : String(body.phase);
        if (requestedPhase !== "sync" && requestedPhase !== "release") {
          res.status(400).json({ error: "body.phase must be sync or release." });
          return;
        }
        const asOf = paidCtx.asOf; // server-resolved AND token-bound (P2); never from the body
        // Admin-only "Force latest D-1": force-latest makes the OLI fetch bypass the stale cache (the SAME reviewed
        // runSourceCardAction forceFreshOli path the GitHub force-latest job uses). The route is assertAdmin-gated.
        const request = validateSourceSyncRequest({ bucket, sourceKey: onlySourceKey, origin: "admin-manual", asOf, refreshMode: body.refreshMode == null ? "normal" : String(body.refreshMode) });
        let syncDone = requestedPhase === "release";
        if (!syncDone) {
          if (onlySourceKey === "ads-campaign-date") {
            const runCampaignAdsBucketSlice = (deps && deps.runCampaignAdsBucketSlice) || (await import("../../lib/server/sync/scheduled-campaign-ads-runner.js")).runCampaignAdsBucketSlice;
            // WP10b P1: the Campaign Ads creates this slice may still make = the approval left after the persisted debit
            // and the release Catalog reserve. Every region is planned first (a plan needing more is refused with ZERO
            // creates) and guardedCreate refuses BEFORE any POST (batch, bisection split, page) that would cross it.
            const adsCreateCap = Math.max(0, Math.floor((paidDebit.remainingTokens - releaseReserveTokens) / CAMPAIGN_ADS_TOKENS_PER_CREATE));
            // WP10b re-verify P1 -- the DURABLE SINGLE-USE RECEIPT for this Ads step. The Ads phase opens no sync cycle, so
            // its spend is carried ONLY in the signed token (`sp`); a stateless token could be replayed (the start token or
            // any older continuation) to reset that debit. So AFTER the as-of / operation / debit / release-reserve checks
            // above and BEFORE the runner (i.e. before ANY DataDoe create), the step (confirmation nonce, Ads slice
            // sequence aq) is claimed ONCE, permanently, as an explicit-primary-key insert into public.audit_log:
            //   claimed          -> this request owns the step; every token it issues names step aq+1 (with the new sp);
            //   already claimed  -> 409 PAID_SYNC_TOKEN_CONSUMED, the fresh estimate WITHOUT a token, ZERO runner calls;
            //   unprovable       -> 503 PAID_SYNC_OPERATION_UNVERIFIABLE (a failed / in-flight / deadline-expired claim),
            //                       ZERO runner calls (a retry of the same token either claims the step or finds it used).
            // Two concurrent executes of one token race on the primary key: exactly one reaches the runner. A crash after
            // the claim but before a continuation token is returned only forces a re-preview (fail closed; spend under this
            // confirmation stays <= its approval because each step's cap is derived from the linear spend chain).
            // SCOPE: the Ads phase ONLY. The OLI / Catalog / whole-bucket / release / FBA debits are re-read from PERSISTED
            // durable counts (sync_source_jobs.create_export_count) on every slice, so a retried token there cannot reset
            // any spend and their poll-retry semantics stay unchanged; the Ads spend is the only spend held in the token.
            // The receipt records the step's scope + the spend before it (never the token, its MAC or any secret).
            let adsReceipt = null;
            try {
              const receiptId = paidSyncAdsReceiptId({ nonce: paidConfirmation.nonce, seq: paidConfirmation.adsSliceSeq });
              adsReceipt = await deadline.bound("paid-ads-receipt", (signal) => depOf(deps, "claimPaidSyncReceipt")({
                receiptId, actorUserId: access.userId, action: "source.sync.paid-ads-receipt",
                target: {
                  bucket, sourceKey: onlySourceKey, asOf, operationKey: paidCtx.operationKey, aq: paidConfirmation.adsSliceSeq,
                  approvedMaxTokens, adsSpentTokensBefore: adsSpentNow, debitedTokensBefore: paidDebit.debitedTokens, maxTotalCreates: adsCreateCap,
                },
              }, { signal }), { write: true });
            } catch { adsReceipt = null; }
            if (!adsReceipt || typeof adsReceipt !== "object") {
              await refusePaid(503, "PAID_SYNC_OPERATION_UNVERIFIABLE", "The single-use record for this confirmation step could not be written, so the step cannot be proven unused; nothing was spent by this request. Retry shortly.");
              return;
            }
            if (adsReceipt.claimed !== true) {
              await refusePaid(409, "PAID_SYNC_TOKEN_CONSUMED", "This confirmation step was already used; review the fresh estimate and confirm again. Nothing was spent by this request.");
              return;
            }
            adsSliceSeqNow = paidConfirmation.adsSliceSeq + 1; // the consumed step is gone for good; the chain moves on
            const ads = await runCampaignAdsBucketSlice({
              bucket, asOf, runKind: "daily", maxCreates: adsCreateCap, maxFallbackCreates: adsCreateCap, maxTotalCreates: adsCreateCap,
              deps: { workerDeps: { workBudgetMs: Math.min(remainingMs() - 4000, 35_000) } },
            });
            // FAIL CLOSED on an unprovable spend report (WP10b round-2 P3-1): the debit below trusts the runner's own counts,
            // so anything but non-negative safe integers (NaN / Infinity / negative / fractional / missing) ends this
            // confirmation with NO continuation token (the step's receipt is already consumed) -- never a 0 debit.
            const intOk = (v) => Number.isSafeInteger(v) && v >= 0;
            if (!ads || typeof ads !== "object" || !intOk(ads.creates) || !intOk(ads.tokens)) {
              res.status(502).json({ error: "PAID_SYNC_RESULT_UNPROVABLE", message: "The Campaign Ads slice reported an unprovable spend, so this confirmation is closed; review the fresh estimate and confirm again before any further paid sync." });
              return;
            }
            // No durable per-create Ads ledger: the slice's spend is carried in the signed continuation token (linear via the
            // receipt). Debited CONSERVATIVELY (the larger of the reported tokens and creates x price) and applied to the
            // in-request debit at once, so every figure returned after this slice -- approval, continuation token, the
            // release gate below -- is POST-slice (P3-3).
            const adsSliceTokens = Math.max(0, Number(ads.tokens) || 0, (Number(ads.creates) || 0) * CAMPAIGN_ADS_TOKENS_PER_CREATE);
            adsSpentNow += adsSliceTokens;
            paidDebit = { ...paidDebit, debitedTokens: paidDebit.debitedTokens + adsSliceTokens, remainingTokens: paidDebit.remainingTokens - adsSliceTokens };
            if (ads.refused === true && ads.code === "CAMPAIGN_ADS_APPROVAL_EXCEEDED") {
              await refusePaid(409, "PAID_SYNC_SCOPE_CHANGED", "The Campaign Ads plan now needs " + ads.plannedCreates + " export(s) but the approval covers only " + ads.maxTotalCreates + "; review the fresh estimate and confirm again. Nothing was created by this request.", { approval: paidApproval() });
              return;
            }
            if (ads.phase !== "complete") {
              operation = ads.continuationRequired === true
                ? { phase: "sync", continuationRequired: true, creates: ads.creates || 0, tokens: ads.tokens || 0 }
                : { phase: "sync", ok: false, problems: ads.problems || [] };
            } else { syncDone = true; result = { adsSync: ads }; }
          } else {
            // WP10b P1: the OPTIONAL approval gate -- the runtime refuses with ZERO creates any step whose remaining frozen
            // exposure + the release Catalog reserve exceeds the approval still unspent.
            const rollup = await runtime.runSourceCardAction({ bucket, sourceKey: onlySourceKey, deadline, preflight, forceFreshOli: request.forceFreshOli === true, approvedTokenCeiling: { remainingTokens: paidDebit.remainingTokens, reserveTokens: releaseReserveTokens } });
            if (rollup && rollup.refused === true) { res.status(409).json({ refusal: rollup, ...refusalText(rollup), status: await boundedStatusFn(deadline) }); return; }
            if (rollup && rollup.approvalRefused === true) {
              await refusePaid(409, "PAID_SYNC_SCOPE_CHANGED", "The planned exports now need " + (rollup.stopReason && rollup.stopReason.exposureTokens) + " tokens (+ " + releaseReserveTokens + " release reserve) but only " + paidDebit.remainingTokens + " of the approved " + approvedMaxTokens + " remain; review the fresh estimate and confirm again. Nothing was created by this request.", { refusal: rollup.stopReason, approval: paidApproval() });
              return;
            }
            if (rollup && rollup.stopped === true) {
              operation = { phase: "sync", ok: false, problems: ["source sync stopped: " + String(rollup.stopReason && rollup.stopReason.code)] };
            } else if (rollup && rollup.continuationRequired === true) {
              operation = { phase: "sync", continuationRequired: true };
            } else { syncDone = true; result = { sourceSync: { cycleId: rollup && rollup.cycleId ? String(rollup.cycleId).slice(0, 8) : null, globalDrained: rollup ? rollup.globalDrained : null } }; }
          }
        }
        if (syncDone && !operation) {
          // RELEASE slice: derive + finalize + preflight-all + open/publish/ALWAYS-safe-close + read-back. The
          // controls store and release surface are the SAME reviewed implementations the operators use.
          const { buildPriorityDashboardsRelease } = await import("../../lib/server/sync/source-priority-dashboards.js");
          const { buildLiveReadback } = await import("../../lib/server/sync/source-priority-release-runner.js");
          const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../../lib/server/sync/report-publisher.js");
          const { REPORT_DERIVATIONS } = await import("../../lib/server/sync/report-derivation.js");
          const { paramsHashFor } = await import("../../lib/server/report-store.js");
          const { runControlPackageCli } = await import("../../lib/server/sync/source-priority-control-package.js");
          const { CONTROLLED_REPORT_KEYS } = await import("../../lib/server/sync/report-controls.js");
          const { connectPriorityControlStore, discoverPrimaryAccountIds } = await import("../../lib/server/sync/priority-control-pg-store.js");
          const sbMod = await import("../../lib/server/supabase.js");
          const operator = access.userId ? "admin:" + String(access.userId) : "admin:data-sync-center";
          // Round-8 blocker 2: a CRYPTOGRAPHICALLY-UNIQUE token per HTTP execution (never derived from
          // operator/bucket). Each release slice applies -> publishes -> safe-closes -> releases, so two
          // concurrent same-admin+bucket requests get different tokens and one defers without altering the other.
          const { randomUUID: randomPriorityToken } = await import("node:crypto");
          const priorityOwnerToken = "route-priority:" + bucket + ":" + randomPriorityToken();
          // Round-9 P0-A/P0-B: the fence captured at controls.apply. getControlFence makes the release's publisher
          // control-enabled, so EVERY priority report write fences this exact fence inside the report_snapshots CAS.
          let priorityFence = null;
          const release = buildPriorityDashboardsRelease({ budgetMs: remainingMs(), asOfOverride: request.asOf, operationKey: request.operationKey, getControlFence: () => priorityFence });
          const readbackLive = buildLiveReadback({
            getReportSnapshot: sbMod.getReportSnapshot,
            loadStoragePayload: sbMod.getReportSnapshotStoragePayload,
            liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
            reportDerivations: REPORT_DERIVATIONS,
            computeHash: paramsHashFor,
          });
          const controls = {
            apply: async () => {
              const r = await runControlPackageCli({ mode: "apply", operator, discoverAccounts: discoverPrimaryAccountIds, connectStore: connectPriorityControlStore, controlledReportKeys: CONTROLLED_REPORT_KEYS, ownerToken: priorityOwnerToken, operationKey: "route-priority/" + bucket });
              if (!r || r.committed !== true) throw new Error("controls apply did not commit" + (r && r.problem ? ": " + r.problem : ""));
              // Round-10 (blocker 6): require a VALID fencing generation IMMEDIATELY -- never continue with a null fence.
              const g = Number(r.leaseGeneration);
              if (!(Number.isSafeInteger(g) && g > 0)) throw new Error("CONTROL_LEASE_NO_GENERATION: controls apply returned no valid fencing generation -- refusing to publish (fail closed).");
              priorityFence = { ownerToken: priorityOwnerToken, generation: g };
            },
            close: async () => {
              const r = await runControlPackageCli({ mode: "rollback", operator, connectStore: connectPriorityControlStore, controlledReportKeys: CONTROLLED_REPORT_KEYS, ownerToken: priorityOwnerToken, ownerGeneration: priorityFence ? priorityFence.generation : null, operationKey: "route-priority/" + bucket });
              if (r && r.skipped === "lease-not-owner") { priorityFence = null; return; } // lost the lease: closes nothing (correct no-op)
              if (!r || r.committed !== true) throw new Error("SAFE-CLOSE did not commit -- verify controls");
              priorityFence = null;
            },
          };
          // WP10b P1 + P2: re-debit from the PERSISTED spend (a sync step in THIS request may have created exports or
          // opened the cycle) and re-prove the operation binding, then gate the release's one possible create (the
          // date's Catalog export) against the approval still unspent -- a typed zero-create refusal otherwise.
          paidDebit = await paidSyncDebit({ claims: paidConfirmation, ctx: paidCtx, deps, adsSpentTokens: adsSpentNow });
          if (!paidDebit.ok) { await refusePaid(paidDebit.status, paidDebit.error, paidDebit.message); return; }
          let rel;
          try {
            rel = await runReleaseSlice({ bucket, release, controls, readbackLive, outOfTime: deadline.outOfTime, approvedTokenCeiling: { remainingTokens: paidDebit.remainingTokens } });
          } catch (relErr) {
            // P1-D: apply could not acquire the global lease (another operation owns it) -> TYPED RETRYABLE 423.
            const rm = String(relErr?.message || "release slice failed");
            if (/CONTROL_LEASE_HELD|CONTROL_LEASE_LOST/.test(rm)) {
              res.status(423).json({ operation: { phase: "contention", ok: false, retryable: true, status: "CONTROL_LEASE_HELD", problems: [rm] }, result, error: "CONTROL_LEASE_HELD", message: CONTENTION_MESSAGE, status: await boundedStatusFn(deadline) });
              return;
            }
            throw relErr;
          }
          // P1-D: control-lease contention (fence lost mid-publish) is a TYPED RETRYABLE 409, never a generic 500.
          if (rel.leaseLost === true || rel.status === "CONTROL_LEASE_LOST") {
            res.status(409).json({ operation: { phase: "contention", ok: false, retryable: true, status: "CONTROL_LEASE_LOST", problems: rel.problems || [] }, result, error: "CONTROL_LEASE_LOST", message: CONTENTION_MESSAGE, status: await boundedStatusFn(deadline) });
            return;
          }
          if (rel.phase === "approval") {
            if (rel.code === "PAID_APPROVAL_EXCEEDED") await refusePaid(409, "PAID_SYNC_SCOPE_CHANGED", "The release needs its Catalog export (" + rel.exposureTokens + " tokens) but only " + rel.remainingTokens + " approved token(s) remain; review the fresh estimate and confirm again. Nothing was created by this request.", { refusal: rel, approval: paidApproval() });
            else await refusePaid(503, "PAID_SYNC_OPERATION_UNVERIFIABLE", "The release's paid exposure could not be proven (" + (rel.problems || []).join("; ") + "); nothing was created. Retry shortly.", { refusal: rel });
            return;
          }
          operation = rel.phase === "complete" && rel.ok === true
            ? { phase: "complete", ok: true, published: rel.published, readback: rel.readback }
            : rel.continuationRequired === true
              ? { phase: "release", continuationRequired: true, detail: rel.phase, published: rel.published ?? null }
              : { phase: rel.phase, ok: false, problems: rel.problems || [] };
        }
        const status = await boundedStatusFn(deadline);
        res.status(200).json({ operation, result, approval: paidApproval(), continuationToken: await nextPaidToken({ finished: !!(operation && operation.phase === "complete" && operation.ok === true) }), status });
        return;
      }
      // Non-orchestrated durable sync (the whole bucket): the SAME optional approval gate, no release reserve.
      const sourceCeiling = { remainingTokens: paidDebit.remainingTokens, reserveTokens: 0 };
      result = onlySourceKey
        ? await runtime.runSourceCardAction({ bucket, sourceKey: onlySourceKey, approvedTokenCeiling: sourceCeiling, deadline, preflight })
        : await runtime.run({ bucket, approvedTokenCeiling: sourceCeiling, deadline, preflight });
      if (result && result.refused === true) {
        res.status(409).json({ refusal: result, ...refusalText(result), status: await boundedStatusFn(deadline) });
        return;
      }
      if (result && result.approvalRefused === true) {
        await refusePaid(409, "PAID_SYNC_SCOPE_CHANGED", "The planned exports now need " + (result.stopReason && result.stopReason.exposureTokens) + " tokens but only " + paidDebit.remainingTokens + " of the approved " + approvedMaxTokens + " remain; review the fresh estimate and confirm again. Nothing was created by this request.", { refusal: result.stopReason, approval: paidApproval() });
        return;
      }
      res.status(200).json({ result, approval: paidApproval(), continuationToken: await nextPaidToken({ finished: !!(result && result.globalDrained === true && result.continuationRequired !== true && result.stopped !== true) }), status: await boundedStatusFn(deadline) });
      return;
    }

    res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    res.status(error?.status || 500).json({ error: error?.message || "Source-control request failed." });
  }
}

// Vercel serverless entry: the production handler wired to the real collaborators (DEFAULT_DEPS). This adds NO new
// api/*.js function -- it is the same single endpoint, now with the established handler(req, res, deps) test seam.
export default function (req, res) { return handler(req, res); }
