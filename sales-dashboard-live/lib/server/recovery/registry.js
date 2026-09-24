// Publication recovery worker -- ONE central registry, DERIVED from the verified existing metadata (never a parallel
// hand-maintained source->report map):
//   * the four reconciler lineage modules (oli/fba/ads/listing-health-v3 *-dependent-reports.js) -> which live dashboard
//     reports each zero-export reconciler family publishes;
//   * SCHEDULER_LIVE_SNAPSHOT_CONTRACTS (report-publisher.js) -> every publishable live key;
//   * REPORT_MATERIALIZATION (report-materialization-registry.js) -> who writes each report + how it is served.
// validateRecoveryRegistry() FAILS CLOSED when a live key or a registry entry cannot be classified, so registering a new
// report without deciding how the worker treats it breaks the test suite instead of silently being skipped.

import { oliDependentLiveReportKeys } from "../sync/oli-dependent-reports.js";
import { fbaDependentLiveReportKeys } from "../sync/fba-dependent-reports.js";
import { adsDependentLiveReportKeys, adsGrainsForReport, adsWorkerKeyForGrain } from "../sync/ads-dependent-reports.js";
import { listingsDependentLiveReportKeys } from "../sync/listing-health-v3-dependent-reports.js";
import { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } from "../sync/report-publisher.js";
import { REPORT_MATERIALIZATION } from "../reports/report-materialization-registry.js";

export const RECOVERY_REGIONS = Object.freeze(["india", "europe-au", "us-ca"]);

// The ONLY child processes the worker may ever spawn: the four existing zero-export reconciler CLIs (each wired with a
// create-refusing DataDoe adapter). Deadlines/hard timeouts mirror the backstop workflows exactly
// (.github/workflows/*-publication-reconcile.yml: --deadline-seconds=330 under `timeout 420`; LHv3 720 / 840).
// awaits: a family whose release needs another family's live output at the same as-of is processed AFTER it:
//   fba  -> brand-inventory requires a proven live brand-sales at requestedAsOf (fba-brand-inventory-release.js:125-135)
//   ads  -> the daily-reporting release requires the exact D-1 OLI (daily-reporting-release.js)
// The Ads CLI runs ONLY its daily-reporting operation (ads-publication-reconcile.mjs: buildOperation("daily-reporting");
// ppc-performance is deliberately superseded there). The worker mirrors exactly what the CLI processes -- pinned by a
// static test against the CLI source -- rather than the broader lineage list.
export const ADS_CLI_OPERATION_REPORT_KEYS = Object.freeze(["daily-reporting"]);

export const RECOVERY_FAMILIES = Object.freeze({
  oli: Object.freeze({ id: "oli", script: "scripts/release/oli-publication-reconcile.mjs", deadlineSeconds: 330, hardTimeoutSeconds: 420, priority: 1, awaits: Object.freeze([]), sources: Object.freeze(["order-line-items"]), reportKeys: () => oliDependentLiveReportKeys() }),
  ads: Object.freeze({ id: "ads", script: "scripts/release/ads-publication-reconcile.mjs", deadlineSeconds: 330, hardTimeoutSeconds: 420, priority: 3, awaits: Object.freeze(["oli"]), sources: Object.freeze(["campaign-ads"]), reportKeys: () => adsDependentLiveReportKeys().filter((k) => ADS_CLI_OPERATION_REPORT_KEYS.includes(k)) }),
  fba: Object.freeze({ id: "fba", script: "scripts/release/fba-publication-reconcile.mjs", deadlineSeconds: 330, hardTimeoutSeconds: 420, priority: 4, awaits: Object.freeze(["oli"]), sources: Object.freeze(["fba-inventory-health"]), reportKeys: () => fbaDependentLiveReportKeys() }),
  listings: Object.freeze({ id: "listings", script: "scripts/release/listing-health-v3-reconcile.mjs", deadlineSeconds: 720, hardTimeoutSeconds: 840, priority: 5, awaits: Object.freeze([]), sources: Object.freeze(["listings", "listings-raw"]), reportKeys: () => listingsDependentLiveReportKeys() }),
});
export const FAMILY_IDS = Object.freeze(Object.keys(RECOVERY_FAMILIES));

// Scripts the worker must NEVER spawn (paid exports, lease/control primitives, scheduler operators). Enforced at the
// runner boundary and by a static test.
export const FORBIDDEN_WORKER_SCRIPTS = Object.freeze([
  "fba-plan-golive.mjs", "listing-health-v3-ingestion.mjs", "priority-dashboards-release.mjs", "priority-control-package.mjs",
  "bootstrap-publish.mjs", "oli-refresh-d1.mjs", "campaign-ads-golive.mjs", "manual-source-sync.mjs",
  "scheduled-campaign-ads-refresh.mjs", "report-materialization.mjs", "report-materialization-brandview.mjs",
]);

// The materialization registry keys a report under a different name than its live contract in one case.
const REGISTRY_KEY_FOR_LIVE = Object.freeze({ "daily-reporting": "daily" });
const LIVE_KEY_FOR_REGISTRY = Object.freeze({ daily: "daily-reporting" });

/** live report key -> [family ids] that publish it through a zero-export reconciler. */
export function familiesForLiveReport(reportKey) {
  return FAMILY_IDS.filter((f) => RECOVERY_FAMILIES[f].reportKeys().includes(reportKey));
}

/**
 * Classify ONE report key (a live contract key or a materialization-registry key). Returns:
 *   { kind: "reconciler", families }                 -- the worker detects AND publishes it via those families
 *   { kind: "detect-only", reason }                  -- a live publication target with NO zero-export publisher
 *   { kind: "not-applicable", reason }               -- read-only/self-healing serve, or manual-refresh (DataDoe) only
 * Throws when the key cannot be classified from verified metadata (fail closed).
 */
export function classifyReport(reportKey, { materialization = REPORT_MATERIALIZATION } = {}) {
  const liveKey = LIVE_KEY_FOR_REGISTRY[reportKey] || reportKey;
  const fams = familiesForLiveReport(liveKey);
  if (fams.length) return { kind: "reconciler", families: fams };
  const reg = materialization[REGISTRY_KEY_FOR_LIVE[liveKey] || liveKey];
  if (!reg) throw new Error(`publication-recovery registry: report '${reportKey}' has no materialization declaration and no reconciler family (fail closed).`);
  const owner = String(reg.materializationOwner || "");
  if (owner === "scheduler-v2:fba") return { kind: "detect-only", reason: "no-zero-export-publisher" };
  if (owner === "scheduler-v2:materialize") return { kind: "detect-only", reason: "scheduler-materialized" };
  if (owner === "manual-refresh") return { kind: "not-applicable", reason: "manual-refresh" };
  if (owner === "serve:derive-durable") return { kind: "not-applicable", reason: "read-only-serve" };
  // A scheduler-published target (priority / v3-shadow) MUST be covered by a reconciler family -- otherwise it is a
  // publication target the worker cannot recover, which must be decided explicitly, never silently skipped.
  throw new Error(`publication-recovery registry: report '${reportKey}' (owner ${owner}) is a scheduler publication target with no reconciler family (fail closed).`);
}

/** Validate the whole registry against the live contracts + materialization registry. Returns the full map. */
export function validateRecoveryRegistry({ liveContracts = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, materialization = REPORT_MATERIALIZATION } = {}) {
  const out = {};
  for (const key of new Set([...Object.keys(liveContracts), ...Object.keys(materialization).map((k) => LIVE_KEY_FOR_REGISTRY[k] || k)])) {
    out[key] = classifyReport(key, { materialization });
  }
  for (const f of FAMILY_IDS) {
    const keys = RECOVERY_FAMILIES[f].reportKeys();
    if (!keys.length) throw new Error(`publication-recovery registry: family '${f}' publishes no live report (fail closed).`);
    for (const k of keys) if (!liveContracts[k]) throw new Error(`publication-recovery registry: family '${f}' report '${k}' has no live snapshot contract (fail closed).`);
    if (FORBIDDEN_WORKER_SCRIPTS.some((s) => RECOVERY_FAMILIES[f].script.endsWith("/" + s))) throw new Error(`family '${f}' maps to a forbidden script`);
  }
  return out;
}

/** Detect-only live keys (a publication target with no zero-export path) -- reported, never published. */
export function detectOnlyReports({ materialization = REPORT_MATERIALIZATION } = {}) {
  const out = [];
  for (const k of Object.keys(materialization)) {
    const liveKey = LIVE_KEY_FOR_REGISTRY[k] || k;
    const c = classifyReport(liveKey, { materialization });
    if (c.kind === "detect-only") out.push({ reportKey: liveKey, reason: c.reason });
  }
  return out;
}

/** The ads_sync_state worker keys whose content_rev feeds the Ads family's live reports (for the evidence token). */
export function adsEvidenceWorkerKeys() {
  const keys = new Set();
  for (const rk of RECOVERY_FAMILIES.ads.reportKeys()) for (const g of adsGrainsForReport(rk)) keys.add(adsWorkerKeyForGrain(g));
  return [...keys].sort();
}
