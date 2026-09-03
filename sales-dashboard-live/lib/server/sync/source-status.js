// Scheduler v2 -- DATA SYNC CENTER SOURCE CARDS + dashboard-readiness summary (pure, ZERO I/O).
//
// Shapes the durable operator surfaces (source_controls + source_run_status + the source registry) into the
// SOURCE-level cards the Data Sync Center renders -- one card per registered source family, carrying exactly
// the reviewed field set: label, last attempt, last success, status + SAFE error, covered_from/covered_to,
// completed/failed/total accounts, stable batch count, creates/tokens spent versus ceiling, the "Used by"
// dashboard list, paused/schedule flags. Everything here is display shaping over already-safe fields --
// never a secret, never a raw error.
//
// The separate READ-ONLY dashboard-readiness summary answers "which source is blocking Daily Reporting or
// Brand View" from the cards alone (paused / never-ran / failed sources that the dashboard requires), so the
// operator sees blockage without any extra query. It controls nothing.

import { SOURCE_REGISTRY, sourceRegistryEntry } from "./source-registry.js";
import { sourceContractForKey } from "../source-contracts.js";
import { ACTIVE_ADS_REGISTRY_KEY, isAdsRegistryKeyRetired } from "../active-ads-source.js";

export const CARD_BUCKETS = Object.freeze(["us", "non-us"]);

// The sources whose health gates each priority dashboard's summary. Sales-blocking sources are the durable
// OLI/catalog evidence; the Ads/inventory sources degrade their half without blocking sales (mirrors
// durable-dashboards readiness semantics). The Ads grain is the ACTIVE grain from the ONE cutover authority
// (ACTIVE_ADS_REGISTRY_KEY = ads-campaign-date post-cutover; ads-asin-date on rollback) -- never the retired grain.
export const PRIORITY_DASHBOARD_SOURCES = Object.freeze({
  "daily-reporting": Object.freeze({
    blocking: Object.freeze(["order-line-items", "product-catalog"]),
    degrading: Object.freeze([ACTIVE_ADS_REGISTRY_KEY]),
  }),
  "brand-view": Object.freeze({
    blocking: Object.freeze(["order-line-items", "product-catalog"]),
    degrading: Object.freeze([ACTIVE_ADS_REGISTRY_KEY, "fba-inventory-health"]),
  }),
});

const toRow = (rows, sourceKey, bucket) => (rows || []).find((r) => (r.source_key ?? r.sourceKey) === sourceKey && (r.bucket === bucket)) || null;
const controlOf = (rows, sourceKey) => (rows || []).find((r) => (r.source_key ?? r.sourceKey) === sourceKey) || null;

/**
 * Shape one bucket's source cards. Inputs are the wrapper results (never re-fetched here):
 *   controls    : getSourceControls().rows      (paused / schedule_enabled per source)
 *   runStatuses : getSourceRunStatuses().rows   (per (source, bucket) operator status)
 * A source with no durable rows still gets a card (status "never") -- the operator sees the full inventory.
 */
export function shapeSourceCards({ bucket, controls = [], runStatuses = [] } = {}) {
  if (!CARD_BUCKETS.includes(bucket)) throw new Error(`shapeSourceCards requires bucket 'us'|'non-us' (got "${bucket}").`);
  return SOURCE_REGISTRY
    // Hide the RETIRED ads grain's card from the active Data Sync Center (server-side, per the ONE cutover
    // authority): while Campaign is active the ads-asin-date card is not rendered and exposes no pause/sync action.
    // Its registry entry, contract, durable history + rollback code are untouched; a forged manual ASIN action is
    // still refused before any DB/DataDoe/token I/O (durable-ads architecture guard + the ads-sync export guard).
    .filter((entry) => !isAdsRegistryKeyRetired(entry.sourceKey))
    .map((entry) => {
    const contract = sourceContractForKey(entry.sourceKey);
    const control = controlOf(controls, entry.sourceKey);
    const s = toRow(runStatuses, entry.sourceKey, bucket) || {};
    const paused = control ? control.paused === true : false;
    return Object.freeze({
      sourceKey: entry.sourceKey,
      label: (contract && contract.label) || entry.sourceKey,
      usedBy: entry.usedByDashboards,
      tokenClass: entry.tokenClass,
      storage: entry.storage,
      batchable: entry.batching.mode === "stable-batch",
      paused,
      scheduleEnabled: control ? control.schedule_enabled === true : false,
      status: Object.freeze({
        lastStatus: paused && !s.last_status ? "paused" : (s.last_status || "never"),
        lastAttemptAt: s.last_attempt_at || null,
        lastSuccessAt: s.last_success_at || null,
        safeErrorCode: s.safe_error_code || null,
        safeErrorStage: s.safe_error_stage || null,
        coveredFrom: s.covered_from || null,
        coveredTo: s.covered_to || null,
        accountsCompleted: s.accounts_completed ?? 0,
        accountsFailed: s.accounts_failed ?? 0,
        accountsTotal: s.accounts_total ?? 0,
        batchCount: s.batch_count ?? 0,
        createsSpent: s.creates_spent ?? 0,
        tokensSpent: s.tokens_spent ?? 0,
        createsCeiling: s.creates_ceiling ?? null,
        tokensCeiling: s.tokens_ceiling ?? null,
      }),
    });
  });
}

// Card-level health for the readiness summary: a source is HEALTHY when its last run succeeded and it is not
// paused. "never" (no run yet), "failed"/"partial", or paused all surface with a typed reason.
function cardHealth(card) {
  if (!card) return { healthy: false, reason: "unregistered-source" };
  if (card.paused) return { healthy: false, reason: "paused" };
  const st = card.status.lastStatus;
  if (st === "succeeded") return { healthy: true, reason: null };
  if (st === "never" || st === "paused") return { healthy: false, reason: "never-succeeded" };
  if (st === "running") return { healthy: false, reason: "still-running" };
  return { healthy: false, reason: "last-run-" + st };
}

/**
 * The READ-ONLY dashboard-readiness summary for one bucket's cards: which source is blocking Daily Reporting
 * or Brand View (sales-blocking) and which merely degrades its Ads/inventory half. Controls nothing; derives
 * only from the cards.
 * Returns [{ dashboard, ready, blockedBy:[{sourceKey, reason}], degradedBy:[{sourceKey, reason}] }].
 */
export function dashboardReadinessSummary(cards) {
  const byKey = new Map((cards || []).map((c) => [c.sourceKey, c]));
  return Object.entries(PRIORITY_DASHBOARD_SOURCES).map(([dashboard, spec]) => {
    const blockedBy = [];
    const degradedBy = [];
    for (const sourceKey of spec.blocking) {
      sourceRegistryEntry(sourceKey); // fail closed on an unregistered summary source
      const h = cardHealth(byKey.get(sourceKey));
      if (!h.healthy) blockedBy.push({ sourceKey, reason: h.reason });
    }
    for (const sourceKey of spec.degrading) {
      sourceRegistryEntry(sourceKey);
      const h = cardHealth(byKey.get(sourceKey));
      if (!h.healthy) degradedBy.push({ sourceKey, reason: h.reason });
    }
    return Object.freeze({
      dashboard,
      ready: blockedBy.length === 0,
      blockedBy: Object.freeze(blockedBy),
      degradedBy: Object.freeze(degradedBy),
    });
  });
}
