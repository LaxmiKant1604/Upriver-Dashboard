// PUBLICATION RECOVERY WP10b (fix) -- the READ-ONLY paid-sync token estimate for the admin Data Sync Center cards.
//
// PROJECT_GUIDANCE sections 2 + 4: before an owner approves a paid sync the preview must state the EXPECTED spend, the
// WORST-CASE exposure (the initial request AND every split the operation may make) and the approved hard ceiling
// separately, with the per-create price. A registry "one export per batch" formula is NOT an upper bound (a new
// account's backfill needs several <=441-day chunks, a coverage gap inside a batch is a separate export, a truncation-
// proven seller is re-sliced weekly, a readiness-rejected seller is peeled off solo, a rejected Ads batch bisects), so
// every estimate here runs the SAME zero-DataDoe planners the runtime executes, over the SAME durable evidence:
//   * order-line-items / product-catalog / whole bucket -> planBucketSourceSync (stable batch membership, clipped durable
//     coverage, readiness isolation + weekly-slice truncation evidence resolved by the runtime's own resolvers) priced by
//     computeFrozenTrancheBudget -- EXACTLY the per-cycle ceiling the runtime freezes (one create per unique canonical
//     request hash); an ACTIVE cycle is priced from its frozen tranche budgets (max_tokens - spent_tokens), exactly as
//     the runtime's approval gate (source-bucket-sync.js paidApprovalExposure) evaluates it;
//   * ads-campaign-date -> planCampaignAdsRegionRun (durable coverage pre-filter; compatibility ASSUMED for every routed
//     account = an upper bound) + the runner's bisection-fallback exposure (campaignAdsPlanExposure).
// If a planner input cannot be read the card is NOT executable (typed `unavailable`), never a fabricated low number.
// Pure over injected readers: ZERO writes, ZERO DataDoe (no discovery GET, no compatible-sources GET, no create).

import { organizationFingerprint } from "../source-identity.js";
import { classifyDirectoryAccounts } from "../datadoe-connections.js";
import { addDaysStr } from "../date-windows.js";
import { planBucketSourceSync, selectCatalogCarrierSeller, OLI_SLICE_REQUEST_KEY } from "./source-bucket-sync.js";
import { bindPrimaryBucketAccounts, validateBatchMembershipRows, oliBatchFamily } from "./source-bucket-sync-runtime.js";
import { computeFrozenTrancheBudget } from "./source-tranche-budget.js";
import { makeSourceTranche } from "./source-tranche.js";
import { registryIsPremiumOf, sourceRegistryEntry, SOURCE_REGISTRY } from "./source-registry.js";
import { OLI_SOURCE_KEY, CATALOG_SOURCE_KEY, FBA_INVENTORY_SOURCE_KEY, ORGANIZATION_SCOPE_KEY } from "./source-durable-model.js";
import { readRecentReadinessRejectionOwnership, readinessIsolationFrom } from "./source-readiness-isolation.js";
import { readRecentTruncatedOliBackfillOwnership, oliBackfillWeeklySellersFrom } from "./oli-backfill-overflow.js";
import { planCampaignAdsRegionRun, regionsForBucket, campaignAdsPlanExposure, CAMPAIGN_ADS_SOURCE_NAME, CAMPAIGN_ADS_TOKENS_PER_CREATE } from "./scheduled-campaign-ads-runner.js";
import { routeAccounts } from "./campaign-region-routing.js";
import { PRIORITY_DASHBOARDS, SCHEDULED_OPERATION_KEY_PREFIX } from "./source-priority-dashboards.js";

const S = (v) => (v == null ? "" : String(v));
export const PAID_TOKENS_PER_CREATE = Object.freeze({ standard: 2, premium: 5 });
const TERMINAL = new Set(["succeeded", "partial", "failed"]);
const CONTINUATION_FAMILIES = Object.freeze([OLI_SOURCE_KEY, CATALOG_SOURCE_KEY, FBA_INVENTORY_SOURCE_KEY]);

// The registry price of ONE create of a source family. An unknown key is priced PREMIUM (never under-stated).
export function tokenCostForSourceKey(sourceKey) {
  try { return sourceRegistryEntry(S(sourceKey)).tokenClass === "premium" ? PAID_TOKENS_PER_CREATE.premium : PAID_TOKENS_PER_CREATE.standard; }
  catch { return PAID_TOKENS_PER_CREATE.premium; }
}

/**
 * The PERSISTED spend of one cycle (pure): sync_source_jobs.create_export_count (0|1 per canonical request hash; set in
 * the SAME transaction that reserves a frozen-budget create or wins the legacy claim, never decremented) x the registry
 * price of the job's family. A job row without the counter but with a claim/export marker counts as one create.
 */
export function persistedCycleSpend(jobs) {
  let creates = 0; let tokens = 0;
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (!j) continue;
    const raw = j.create_export_count ?? j.createExportCount;
    let n = raw == null ? NaN : Number(raw);
    if (!Number.isFinite(n)) n = (j.attempted_at ?? j.attemptedAt ?? j.export_id ?? j.exportId) ? 1 : 0;
    if (!(n > 0)) continue;
    creates += n;
    tokens += n * tokenCostForSourceKey(j.source_key ?? j.sourceKey);
  }
  return { creates, tokens };
}

// The durable directory rows mapped to the discovery shape classifyDirectoryAccounts / bindPrimaryBucketAccounts use.
function directoryAsDiscovery(directoryRows) {
  return (Array.isArray(directoryRows) ? directoryRows : [])
    .filter((r) => r && S(r.account_id).trim())
    .map((r) => ({ id: S(r.account_id).trim(), accountId: S(r.account_id).trim(), country: S(r.marketplace_country_code || r.country).trim(), name: r.name || null, currency: r.currency || null }));
}

const unavailable = (reason, extra = {}) => ({ unavailable: String(reason), ...extra });

/**
 * The priority release's remaining Catalog exposure for the date's scheduled operation key (read-only): 0 when ANY
 * reservation row exists (the durable guard never creates a second one), else one standard Catalog create.
 */
export async function releaseCatalogExposure({ asOf, getPriorityCatalogReservation }) {
  const operationKey = SCHEDULED_OPERATION_KEY_PREFIX + S(asOf);
  const r = await getPriorityCatalogReservation(operationKey, null);
  return { operationKey, reservationRecorded: !!r, reserveTokens: r ? 0 : PRIORITY_DASHBOARDS.catalogTokenCost, tokensPerCreate: PRIORITY_DASHBOARDS.catalogTokenCost };
}

/**
 * Source-sync paid exposure (order-line-items / product-catalog card, or the whole bucket when sourceKey is null).
 * readers: { readSourceControls, readCoverage, readSnapshot, readBatchMembership, getBudget, getExportCacheMeta,
 *            readRecentSyncCycleIds, readSyncSourceJobsWithMeta, readSyncSourceJobOwnersForCycle }
 * head / headJobs: the operation slot's CURRENT head cycle + its persisted source jobs (read by the caller).
 * Returns { basis, accounts, families:[...], expectedCreates, expectedTokens, worstCaseCreates, worstCaseTokens,
 *           followOnSplit, planSummary, cycle } | { unavailable }.
 */
export async function planSourceSyncPaidExposure({ bucket, sourceKey = null, refreshMode = "normal", directoryRows, connections, today, nowMs, head = null, headJobs = [], readers }) {
  const primary = (connections || []).find((c) => c && c.id === "primary" && S(c.apiKey).trim());
  if (!primary) return unavailable("primary-connection-missing");
  const orgFingerprint = primary.organizationFingerprint || organizationFingerprint(primary.apiKey);
  // Controls FIRST (the runtime's order). A non-ok read is a typed refusal there -> not executable here.
  let controls;
  try { controls = await readers.readSourceControls(); } catch { controls = null; }
  if (!controls || controls.read !== "ok") return unavailable("source-controls-" + S(controls && controls.read || "read-failed"));
  const pausedSources = new Set((controls.rows || []).filter((r) => r && r.paused === true).map((r) => S(r.source_key)));
  if (sourceKey && pausedSources.has(sourceKey)) return unavailable("source-paused");
  if (sourceKey) for (const e of SOURCE_REGISTRY) if (e.sourceKey !== sourceKey) pausedSources.add(e.sourceKey);

  const discovered = directoryAsDiscovery(directoryRows);
  const { active } = classifyDirectoryAccounts(discovered, connections);
  const { accounts } = bindPrimaryBucketAccounts(active, bucket);
  const catalogCarrierSeller = selectCatalogCarrierSeller(active);
  const asOf = addDaysStr(today, -1);
  const cycle = head && head.id ? { id: S(head.id), status: S(head.status), terminal: TERMINAL.has(S(head.status)) } : null;
  const base = { basis: "runtime-planner", accounts: accounts.length, asOf, cycle, tokensPerCreate: PAID_TOKENS_PER_CREATE };
  const empty = { ...base, families: [], expectedCreates: 0, expectedTokens: 0, worstCaseCreates: 0, worstCaseTokens: 0, followOnSplit: { creates: 0, tokens: 0 } };
  if (!accounts.length) return { ...empty, note: "no-bucket-accounts" };
  // A TERMINAL head: the runtime short-circuits (cycle-terminal) -- the sync step creates nothing today.
  if (cycle && cycle.terminal) return { ...empty, note: "cycle-terminal (the day's sync is complete; zero sync creates)" };

  const jobs = Array.isArray(headJobs) ? headJobs : [];
  const inScope = (k) => !pausedSources.has(k);
  const cacheAdoptable = async (hash, familyKey) => {
    if (refreshMode === "force-latest" && familyKey === OLI_SOURCE_KEY) return false; // forceFreshOli skips the cache
    if (typeof readers.getExportCacheMeta !== "function") return false;
    try { return !!(await readers.getExportCacheMeta(hash)); } catch { return false; }
  };

  // ACTIVE cycle with persisted work = a STRICT CONTINUATION: price each in-scope family from its frozen budget (the
  // runtime gate's "frozen-remaining" basis), an originally-planned-unfrozen family from its persisted identities (the
  // freeze the loop would make), a newly-enabled family at zero (it joins the NEXT cycle).
  if (cycle && jobs.length) {
    const families = [];
    for (const key of CONTINUATION_FAMILIES) {
      if (!inScope(key)) continue;
      const trancheKey = "source-sync:" + key;
      let row;
      try { row = await readers.getBudget({ cycleId: cycle.id, trancheKey }); } catch { return unavailable("frozen-budget-unreadable"); }
      const famJobs = jobs.filter((j) => S(j.source_key ?? j.sourceKey) === key);
      const pendingJobs = famJobs.filter((j) => Number(j.create_export_count ?? j.createExportCount ?? 0) === 0 && S(j.fetch_status ?? j.fetchStatus ?? "pending") === "pending");
      const price = tokenCostForSourceKey(key);
      let worstTokens;
      let basis;
      if (row) {
        const max = Number(row.max_tokens ?? row.maxTokens);
        const spent = Number(row.spent_tokens ?? row.spentTokens ?? 0);
        worstTokens = Number.isFinite(max) ? Math.max(0, max - (Number.isFinite(spent) ? spent : 0)) : new Set(famJobs.map((j) => S(j.request_hash ?? j.requestHash))).size * price;
        basis = "frozen-remaining";
      } else if (famJobs.length) {
        worstTokens = new Set(famJobs.map((j) => S(j.request_hash ?? j.requestHash))).size * price;
        basis = "persisted-unfrozen";
      } else { continue; }
      let expectedCreates = 0;
      for (const j of pendingJobs) if (!(await cacheAdoptable(S(j.request_hash ?? j.requestHash), key))) expectedCreates += 1;
      const expectedTokens = Math.min(worstTokens, expectedCreates * price);
      families.push({ sourceKey: key, basis, tokensPerExport: price, expectedCreates, expectedTokens, worstCaseCreates: Math.ceil(worstTokens / price), worstCaseTokens: worstTokens });
    }
    return summarize({ ...base, families, note: "continuation of the active cycle (frozen tranche budgets)" });
  }

  // FRESH plan (no active head, or an unpopulated one): the runtime's own evidence + planner.
  const coverageByAccountId = {};
  for (const a of accounts) {
    let cov;
    try { cov = await readers.readCoverage({ organizationFingerprint: orgFingerprint, accountId: a.accountId, sourceKey: OLI_SOURCE_KEY }); } catch { cov = null; }
    if (!cov || cov.read !== "ok") return unavailable("oli-coverage-" + S(cov && cov.read || "read-failed"));
    coverageByAccountId[a.accountId] = cov.windows || [];
  }
  let catalogSnapshot = null;
  if (inScope(CATALOG_SOURCE_KEY)) {
    let snap;
    try { snap = await readers.readSnapshot({ organizationFingerprint: orgFingerprint, connectionId: "primary", sourceKey: CATALOG_SOURCE_KEY, scopeKey: ORGANIZATION_SCOPE_KEY }); } catch { snap = null; }
    if (!snap || snap.read !== "ok") return unavailable("catalog-snapshot-" + S(snap && snap.read || "read-failed"));
    catalogSnapshot = snap.snapshot || null;
  }
  const fbaSnapshotsByAccount = {};
  if (inScope(FBA_INVENTORY_SOURCE_KEY)) {
    for (const a of accounts) {
      let snap;
      try { snap = await readers.readSnapshot({ organizationFingerprint: orgFingerprint, connectionId: "primary", sourceKey: FBA_INVENTORY_SOURCE_KEY, scopeKey: a.accountId }); } catch { snap = null; }
      if (!snap || snap.read !== "ok") return unavailable("fba-snapshot-" + S(snap && snap.read || "read-failed"));
      if (snap.snapshot) fbaSnapshotsByAccount[a.accountId] = snap.snapshot;
    }
  }
  let existingMembership;
  try { existingMembership = validateBatchMembershipRows(await readers.readBatchMembership(oliBatchFamily({ orgFingerprint, bucket })), { orgFingerprint }); }
  catch { return unavailable("batch-membership-unreadable"); }
  // The runtime's own self-heal evidence (fail-soft to empty, EXACTLY as the runtime resolves it).
  const evidenceReaders = {
    readRecentCycleIds: (cb, since) => readers.readRecentSyncCycleIds(cb, since),
    readSourceJobs: (cid) => readers.readSyncSourceJobsWithMeta(cid),
    readOwners: (cid) => readers.readSyncSourceJobOwnersForCycle(cid),
  };
  const now = () => nowMs;
  let readinessIsolateSellers = new Set();
  try {
    const { isolateScopeHashes } = await readRecentReadinessRejectionOwnership({ requestKey: OLI_SLICE_REQUEST_KEY, cycleBucket: bucket, now, connectionId: "primary", organizationFingerprint: orgFingerprint, ...evidenceReaders });
    readinessIsolateSellers = readinessIsolationFrom({ defaultBatches: [{ sellerOrVendorIds: accounts.map((a) => S(a.rawSellerId)).filter(Boolean) }], isolateScopeHashes }).isolateSellers;
  } catch { readinessIsolateSellers = new Set(); }
  let oliBackfillWeeklySellers = new Set();
  try {
    const truncatedScopeHashes = await readRecentTruncatedOliBackfillOwnership({ cycleBucket: bucket, now, connectionId: "primary", organizationFingerprint: orgFingerprint, excludeCycleId: cycle ? cycle.id : null, ...evidenceReaders });
    oliBackfillWeeklySellers = oliBackfillWeeklySellersFrom({ truncatedScopeHashes, sellerIds: accounts.map((a) => S(a.rawSellerId)).filter(Boolean) });
  } catch { oliBackfillWeeklySellers = new Set(); }

  let plan;
  try {
    plan = planBucketSourceSync({
      apiKey: primary.apiKey, bucket, accounts, existingMembership, coverageByAccountId, catalogSnapshot, fbaSnapshotsByAccount,
      pausedSources, asOf, today, catalogCarrierSeller, readinessIsolateSellers, oliBackfillWeeklySellers,
    });
  } catch (e) { return unavailable("planner-failed", { detail: S(e && e.message).slice(0, 200) }); }

  const families = [];
  let followOnCreates = 0;
  for (const family of plan.families) {
    if (!family.plannedJobs.length) continue;
    const frozen = computeFrozenTrancheBudget({
      plannedJobs: family.plannedJobs, sourceTranche: makeSourceTranche({ name: family.sourceKey, sourceKeys: [family.sourceKey] }),
      isPremiumOf: registryIsPremiumOf, trancheKey: "source-sync:" + family.sourceKey,
    });
    let expectedCreates = 0; let expectedTokens = 0;
    for (const h of frozen.hashes) {
      if (await cacheAdoptable(h.requestHash, family.sourceKey)) continue;
      expectedCreates += 1; expectedTokens += h.tokenCost;
    }
    const entry = {
      sourceKey: family.sourceKey, basis: "frozen-plan", tokensPerExport: tokenCostForSourceKey(family.sourceKey),
      expectedCreates, expectedTokens, worstCaseCreates: frozen.maxCreates, worstCaseTokens: frozen.maxTokens,
    };
    if (family.sourceKey === OLI_SOURCE_KEY && Array.isArray(family.units)) {
      entry.exportUnits = family.units.length;
      entry.weeklySlicedSellers = [...oliBackfillWeeklySellers].length;
      entry.readinessIsolatedSellers = [...readinessIsolateSellers].length;
      // FOLLOW-ON exposure (NOT spendable by this approval): an export returning exactly the 50,000-row cap is never
      // persisted as complete; its sellers are re-sliced by canonical weekly bins on a LATER operation that needs its
      // own confirmation. Upper bound: every planned unit truncates -> sellers x weeks(slice) single-seller exports.
      for (const u of family.units) {
        const days = Math.max(1, Math.round((Date.parse(u.slice.to + "T00:00:00Z") - Date.parse(u.slice.from + "T00:00:00Z")) / 86400000) + 1);
        followOnCreates += Math.max(1, (u.accounts || []).length) * Math.ceil(days / 7);
      }
    }
    families.push(entry);
  }
  return summarize({
    ...base, families, planSummary: plan.summary,
    followOnSplit: { creates: followOnCreates, tokens: followOnCreates * PAID_TOKENS_PER_CREATE.standard, note: "Not spendable by this approval: a truncated (exactly 50,000-row) export is re-sliced weekly on a LATER operation that needs its own confirmation." },
  });
}

function summarize(est) {
  const fams = est.families || [];
  return {
    ...est,
    followOnSplit: est.followOnSplit || { creates: 0, tokens: 0 },
    expectedCreates: fams.reduce((t, f) => t + f.expectedCreates, 0),
    expectedTokens: fams.reduce((t, f) => t + f.expectedTokens, 0),
    worstCaseCreates: fams.reduce((t, f) => t + f.worstCaseCreates, 0),
    worstCaseTokens: fams.reduce((t, f) => t + f.worstCaseTokens, 0),
  };
}

/**
 * Campaign Ads paid exposure for one bucket (read-only): every region the bucket spans is planned with the runner's
 * own planCampaignAdsRegionRun over the durable account directory + durable Campaign coverage, with Amazon-Ads
 * compatibility ASSUMED for every routed account (the zero-token compatible-sources probe is a DataDoe call; assuming
 * compatibility can only ADD batches -> an upper bound). Expected = one create per <=5-seller batch; worst case adds
 * the runner's bisection-fallback exposure (one create per pending seller).
 */
export async function planCampaignAdsPaidExposure({ bucket, asOf, directoryRows, connections, readers }) {
  const primaryConn = (connections || []).find((c) => c && c.id === "primary" && S(c.apiKey).trim());
  if (!primaryConn) return unavailable("primary-connection-missing");
  const { active } = classifyDirectoryAccounts(directoryAsDiscovery(directoryRows), connections);
  const seen = new Set();
  const accounts = [];
  for (const a of active) {
    const accountId = S(a.accountId ?? a.id).trim();
    if (!accountId || accountId.includes(":") || seen.has(accountId)) continue;
    seen.add(accountId);
    accounts.push({ accountId, marketplace: S(a.country).toUpperCase() });
  }
  const routed = { primaryConn, accounts, ...routeAccounts(accounts) };
  const regions = [];
  for (const region of regionsForBucket(bucket)) {
    let plan;
    try {
      plan = await planCampaignAdsRegionRun({
        region, asOf, runKind: "daily", routed,
        deps: { fetchCompatibleSourceNames: async () => new Set([CAMPAIGN_ADS_SOURCE_NAME]), getCoverage: readers.getCoverage },
      });
    } catch (e) { return unavailable("campaign-ads-planner-failed", { detail: S(e && e.message).slice(0, 200) }); }
    const x = campaignAdsPlanExposure(plan);
    regions.push({ region, accounts: plan.regionAccounts.length, covered: plan.covered.length, pendingAccounts: x.pendingAccounts, normalCreates: x.normalCreates, fallbackCreates: x.fallbackCreates });
  }
  const normal = regions.reduce((t, r) => t + r.normalCreates, 0);
  const fallback = regions.reduce((t, r) => t + r.fallbackCreates, 0);
  const price = CAMPAIGN_ADS_TOKENS_PER_CREATE;
  return {
    basis: "campaign-ads-planner", accounts: accounts.length, unassignedAccounts: (routed.unassigned || []).length, asOf, regions,
    tokensPerCreate: PAID_TOKENS_PER_CREATE,
    families: [{ sourceKey: "ads-campaign-date", basis: "region-plan", tokensPerExport: price, expectedCreates: normal, expectedTokens: normal * price, worstCaseCreates: normal + fallback, worstCaseTokens: (normal + fallback) * price, bisectionFallbackCreates: fallback }],
    expectedCreates: normal, expectedTokens: normal * price, worstCaseCreates: normal + fallback, worstCaseTokens: (normal + fallback) * price,
    followOnSplit: { creates: 0, tokens: 0 },
  };
}
