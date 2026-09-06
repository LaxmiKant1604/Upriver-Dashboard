// CANONICAL REPORT-MATERIALIZATION REGISTRY (Phase 2 -- the ONE place every user-facing report declares HOW it is
// populated from durable backend evidence). It sits beside the two existing registries and is cross-checked against
// them: REPORT_CAPABILITIES (report-authorization.js -- the authoritative "what is a report + its brand capability")
// and REPORT_DERIVATIONS / REPORT_SOURCE_CONTRACTS (report-derivation.js / report-source-contracts.js -- the snapshot
// version + source contracts). Every REPORT capability MUST have exactly one entry here, and every entry MUST declare
// a BACKEND materialization path (never "only when a user opens the page"). The registry-coverage guard
// (report-materialization-registry.test.js) fails a future report that ships without a complete declaration -- so a new
// report is STRUCTURALLY prevented from depending on page-open materialization.
//
// This module is PURE + dependency-light (imports only the other registries) so it is fully offline-testable. It
// changes NO report formula, owner, or serving behaviour -- it DOCUMENTS + ENFORCES the current contract and blocks a
// future undeclared report. (Migrating a report from an on-read/self-heal owner to a scheduler owner is a later,
// separately-scoped change; this registry records today's honest owner so that change is reviewable + testable.)

import { REPORT_CAPABILITIES, CAPABILITY } from "../report-authorization.js";
import { REPORT_DERIVATIONS } from "../sync/report-derivation.js";
import { REPORT_SOURCE_CONTRACTS } from "../sync/report-source-contracts.js";

// ---- Controlled vocabularies (a declaration field with a value outside its enum fails the guard) ----------------

// WHO refreshes the durable SOURCE evidence the report derives from.
export const SOURCE_OWNERS = Object.freeze(["scheduler-v2", "manual-refresh", "none"]);
// WHO produces the durable REPORT artifact (snapshot) -- the backend materialization path. "serve:derive-durable" is a
// zero-DataDoe derive from already-durable sources; "serve:self-heal" additionally WRITES a snapshot on a read miss
// (the page-open-write reports flagged for the later scheduler-move); "manual-refresh" = only a user Refresh (DataDoe)
// materializes it today (no automatic owner). Every value is a BACKEND path (none is "page-open-only with no backend").
export const MATERIALIZATION_OWNERS = Object.freeze([
  "scheduler-v2:priority",   // priority-dashboards-release.mjs derives+publishes per region
  "scheduler-v2:fba",        // the scheduler-v2 fba job (fba-plan-golive.mjs) publishes per region
  "scheduler-v2:v3-shadow",  // the scheduler-v2 listing-health-v3 shadow ingestion (UI flag off)
  "serve:derive-durable",    // zero-DataDoe derive-at-serve from durable evidence (no write)
  "serve:self-heal",         // zero-DataDoe derive-at-serve that persists a snapshot on a read miss (page-open write)
  "manual-refresh",          // materialized only by an explicit user Refresh (DataDoe); no automatic owner yet
]);
export const SERVE_MODES = Object.freeze([
  "read-snapshot",             // read a durable snapshot; else stale-LKG or "waiting"
  "read-snapshot-else-waiting",
  "derive-at-serve",           // compute from durable sources each GET (no write)
  "self-heal-write-on-read",   // compute + persist a snapshot on a read miss (zero DataDoe)
]);
export const GRAINS = Object.freeze(["account", "account-brand", "account-region", "region", "organization"]);
export const LKG_POLICIES = Object.freeze(["serve-last-known-good", "waiting-if-missing", "derive-fresh-each-read"]);
export const REGIONAL_SCHEDULING = Object.freeze(["per-region-daily", "shadow", "on-demand", "manual-only"]);

export const REQUIRED_DECLARATION_FIELDS = Object.freeze([
  "reportKey", "reportVersion", "requiredSources", "optionalSources", "sourceOwner", "materializationOwner",
  "grain", "freshness", "provenanceFields", "lkgPolicy", "regionalScheduling", "capability", "serveMode",
  "bucket", "pageOpenWrite", "clientOpenTriggeredWrite", "notes",
]);

// GRANDFATHERED page-open writes (Phase 3). The EXACT, named set of reports whose plain-GET serve path STILL writes a
// snapshot on a read miss (zero DataDoe self-heal), pending their move fully into the scheduler-owned materializer.
// This is a SHRINKING allowlist: as each report's serve is made read-only, it is removed from here AND its
// pageOpenWrite is flipped to false, and the guard asserts the two stay in lockstep (the set of pageOpenWrite:true
// reports must EQUAL this allowlist). A NEW report can never appear here without a deliberate, reviewable edit that a
// reviewer will reject -- so a new report is structurally prevented from shipping a page-open write. DO NOT ADD.
export const PAGE_OPEN_WRITE_GRANDFATHERED = Object.freeze([
  "daily", "sku-movement", "returns-leakage", "brand-view-brands", "brand-directory",
]);

// Client-open-triggered writes (a browser page-open/converge effect that calls the WRITE endpoint refresh=1). Phase 3
// removed the last two (BrandView + BrandPortfolio auto-converge now poll read-only), so this allowlist is EMPTY and
// every report must declare clientOpenTriggeredWrite:false. It stays empty: no report may reintroduce a client-open write.
export const CLIENT_OPEN_TRIGGERED_WRITE_GRANDFATHERED = Object.freeze([]);

// A source key is durable/scheduled evidence a derive reads. (These are `sourceKey` values from the source contracts /
// the durable stores -- NOT DataDoe request keys.)
// Source keys are the ACTUAL `sourceKey` values used by the source contracts / durable stores (verified against
// REPORT_SOURCE_CONTRACTS). OLI + Product Catalog are frequently DERIVED durable dependencies (not "owned exports" in a
// report's contract), so a report may declare them even when its contract does not own them.
const OLI = "order-line-items";
const CATALOG = "product-catalog";
const FBA = "fba-inventory-health";
const ADS = "campaign-performance"; // durable Campaign Ads rows (ads_daily_source_rows, source_key campaign-performance-v1)
const LISTINGS = "listings";
const LISTINGS_RAW = "listings-raw";
const RETURNS = "returns";
const SETTLEMENTS = "settlements";
const PROFIT_BY_SKU = "profit-by-sku-date";
const SALES_TRAFFIC = "sales-traffic-asin-date";
const SQP_WEEKLY = "sqp-weekly";
const SQP_MONTHLY = "sqp-monthly";
const CONTENT = "content-changes";

const vTag = (reportKey) => (REPORT_DERIVATIONS[reportKey] && REPORT_DERIVATIONS[reportKey].snapshotVersion) || null;

// ---- The registry. One entry per REPORT action in REPORT_CAPABILITIES (NON_REPORT actions are intentionally absent).
export const REPORT_MATERIALIZATION = Object.freeze({
  "brand-sales": {
    reportKey: "brand-sales", reportVersion: vTag("brand-sales"),
    requiredSources: [OLI, CATALOG], optionalSources: [ADS],
    sourceOwner: "scheduler-v2", materializationOwner: "scheduler-v2:priority",
    grain: "account-brand", freshness: { maxAgeHours: 24, coverage: "D-1" },
    provenanceFields: ["source_refreshed_at", "salesSource", "currencies"], lkgPolicy: "serve-last-known-good",
    regionalScheduling: "per-region-daily", capability: REPORT_CAPABILITIES["brand-sales"],
    serveMode: "read-snapshot", bucket: "A", pageOpenWrite: false, clientOpenTriggeredWrite: false,
    notes: "Dashboard/Account. Ads is optional (merged at account grain in Daily; brand attribution needs campaign_brand_mapping).",
  },
  "daily": {
    reportKey: "daily-reporting", reportVersion: vTag("daily-reporting"),
    requiredSources: [OLI, CATALOG], optionalSources: [ADS],
    sourceOwner: "scheduler-v2", materializationOwner: "scheduler-v2:priority",
    grain: "account-brand", freshness: { maxAgeHours: 24, coverage: "D-1" },
    provenanceFields: ["source_refreshed_at", "salesWindowStatus", "coverage"], lkgPolicy: "serve-last-known-good",
    regionalScheduling: "per-region-daily", capability: REPORT_CAPABILITIES["daily"],
    serveMode: "self-heal-write-on-read", bucket: "A", pageOpenWrite: true, clientOpenTriggeredWrite: false,
    notes: "Scheduler-published AND self-heals+writes on a read miss (zero DataDoe). pageOpenWrite=true -> a candidate to move fully into the scheduler so GET is read-only.",
  },
  "brand-inventory": {
    reportKey: "brand-inventory", reportVersion: vTag("brand-inventory"),
    requiredSources: [FBA], optionalSources: [],
    sourceOwner: "scheduler-v2", materializationOwner: "scheduler-v2:priority",
    grain: "account-brand", freshness: { maxAgeHours: 24, coverage: "latest-snapshot" },
    provenanceFields: ["source_refreshed_at", "inventorySnapshotDate"], lkgPolicy: "serve-last-known-good",
    regionalScheduling: "per-region-daily", capability: REPORT_CAPABILITIES["brand-inventory"],
    serveMode: "read-snapshot", bucket: "A", pageOpenWrite: false, clientOpenTriggeredWrite: false,
    notes: "Compact FBA inventory snapshot (SOURCE_PROMOTED). Latest inventory date only; never summed across dates.",
  },
  "fba-plan": {
    reportKey: "fba-plan", reportVersion: vTag("fba-plan"),
    requiredSources: [FBA, OLI, CATALOG], optionalSources: [LISTINGS], // contract owns fba-inventory-health + listings(AWD); OLI/catalog derived
    sourceOwner: "scheduler-v2", materializationOwner: "scheduler-v2:fba",
    grain: "account", freshness: { maxAgeHours: 24, coverage: "latest-snapshot" },
    provenanceFields: ["source_refreshed_at", "inventorySnapshotDate", "asOf"], lkgPolicy: "serve-last-known-good",
    regionalScheduling: "per-region-daily", capability: REPORT_CAPABILITIES["fba-plan"],
    serveMode: "read-snapshot-else-waiting", bucket: "A", pageOpenWrite: false, clientOpenTriggeredWrite: false,
    notes: "Published by the scheduler-v2 fba job per region (AWD optional, US+EU5). Also the FBA fallback for Brand View.",
  },
  "sku-movement": {
    reportKey: "sku-movement", reportVersion: vTag("sku-movement"),
    requiredSources: [OLI, CATALOG], optionalSources: [],
    sourceOwner: "scheduler-v2", materializationOwner: "serve:self-heal",
    grain: "account", freshness: { maxAgeHours: 24, coverage: "selectable-window" },
    provenanceFields: ["source_refreshed_at"], lkgPolicy: "serve-last-known-good",
    regionalScheduling: "per-region-daily", capability: REPORT_CAPABILITIES["sku-movement"],
    serveMode: "self-heal-write-on-read", bucket: "B", pageOpenWrite: true, clientOpenTriggeredWrite: false,
    notes: "Sources scheduled; report self-heals+writes on read from durable OLI/Catalog (zero DataDoe). Move to scheduler to make GET read-only.",
  },
  "returns-leakage": {
    reportKey: "returns-leakage", reportVersion: vTag("returns-leakage"),
    requiredSources: [RETURNS, SETTLEMENTS, OLI], optionalSources: [CATALOG],
    sourceOwner: "manual-refresh", materializationOwner: "serve:self-heal",
    grain: "account-brand", freshness: { maxAgeHours: 168, coverage: "durable-history" },
    provenanceFields: ["source_refreshed_at"], lkgPolicy: "serve-last-known-good",
    regionalScheduling: "manual-only", capability: REPORT_CAPABILITIES["returns-leakage"],
    serveMode: "self-heal-write-on-read", bucket: "B", pageOpenWrite: true, clientOpenTriggeredWrite: false,
    notes: "Returns workflow is manual-only (crons removed); report self-heals+writes on a read miss from durable Returns/Settlement/OLI.",
  },
  "brand-view": {
    reportKey: "brand-view", reportVersion: null,
    requiredSources: [OLI, CATALOG], optionalSources: [ADS, FBA],
    sourceOwner: "scheduler-v2", materializationOwner: "serve:derive-durable",
    grain: "account-brand", freshness: { maxAgeHours: 24, coverage: "D-1" },
    provenanceFields: ["adsAvailable", "fbaAvailable", "inventoryScope", "updating"], lkgPolicy: "serve-last-known-good",
    regionalScheduling: "on-demand", capability: REPORT_CAPABILITIES["brand-view"],
    serveMode: "read-snapshot", bucket: "B", pageOpenWrite: false, clientOpenTriggeredWrite: false,
    notes: "Aggregation of the scheduler-materialized brand-sales/brand-inventory + durable ads; serves LKG + updating when stale.",
  },
  "brand-view-portfolio": {
    reportKey: "brand-view-portfolio", reportVersion: null,
    requiredSources: [OLI, CATALOG], optionalSources: [ADS, FBA],
    sourceOwner: "scheduler-v2", materializationOwner: "serve:derive-durable",
    grain: "account-region", freshness: { maxAgeHours: 24, coverage: "D-1" },
    provenanceFields: ["adsAvailable", "fbaAvailable", "updating"], lkgPolicy: "serve-last-known-good",
    regionalScheduling: "on-demand", capability: REPORT_CAPABILITIES["brand-view-portfolio"],
    serveMode: "read-snapshot", bucket: "B", pageOpenWrite: false, clientOpenTriggeredWrite: false,
    notes: "Cross-account per-region Brand View. Never rebuilds inline on read (deferRebuildOnRead); serves LKG + updating.",
  },
  "brand-portfolio": {
    reportKey: "brand-portfolio", reportVersion: null,
    requiredSources: [OLI, CATALOG], optionalSources: [ADS, FBA],
    sourceOwner: "scheduler-v2", materializationOwner: "serve:derive-durable",
    grain: "account-brand", freshness: { maxAgeHours: 24, coverage: "D-1" },
    provenanceFields: ["source_refreshed_at"], lkgPolicy: "serve-last-known-good",
    regionalScheduling: "on-demand", capability: REPORT_CAPABILITIES["brand-portfolio"],
    serveMode: "read-snapshot", bucket: "B", pageOpenWrite: false, clientOpenTriggeredWrite: false,
    notes: "Legacy brand portfolio aggregation of brand-sales + fba-plan.",
  },
  "brand-view-brands": {
    reportKey: "brand-view-brands", reportVersion: null,
    requiredSources: [OLI, CATALOG], optionalSources: [],
    sourceOwner: "scheduler-v2", materializationOwner: "serve:self-heal",
    grain: "account", freshness: { maxAgeHours: 24, coverage: "D-1" },
    provenanceFields: ["source_refreshed_at"], lkgPolicy: "serve-last-known-good",
    regionalScheduling: "on-demand", capability: REPORT_CAPABILITIES["brand-view-brands"],
    serveMode: "self-heal-write-on-read", bucket: "B", pageOpenWrite: true, clientOpenTriggeredWrite: false,
    notes: "Brand dropdown directory; writes on a read miss (zero DataDoe) from brand-sales membership.",
  },
  "brand-directory": {
    reportKey: "brand-directory", reportVersion: null,
    requiredSources: [OLI, CATALOG], optionalSources: [],
    sourceOwner: "scheduler-v2", materializationOwner: "serve:self-heal",
    grain: "organization", freshness: { maxAgeHours: 24, coverage: "D-1" },
    provenanceFields: ["source_refreshed_at"], lkgPolicy: "serve-last-known-good",
    regionalScheduling: "on-demand", capability: REPORT_CAPABILITIES["brand-directory"],
    serveMode: "self-heal-write-on-read", bucket: "B", pageOpenWrite: true, clientOpenTriggeredWrite: false,
    notes: "Account/brand selector; rebuilds+writes on read when the brand-sales fingerprint changes (zero DataDoe). Refresh (Catalog export) is admin-gated.",
  },
  "oli-quality": {
    reportKey: "oli-quality", reportVersion: null,
    requiredSources: [OLI], optionalSources: [],
    sourceOwner: "scheduler-v2", materializationOwner: "serve:derive-durable",
    grain: "account", freshness: { maxAgeHours: 24, coverage: "D-1" },
    provenanceFields: ["source_refreshed_at"], lkgPolicy: "derive-fresh-each-read",
    regionalScheduling: "on-demand", capability: REPORT_CAPABILITIES["oli-quality"],
    serveMode: "derive-at-serve", bucket: "B", pageOpenWrite: false, clientOpenTriggeredWrite: false,
    notes: "Pure read-derive from the durable OLI table; never stored, never DataDoe.",
  },
  "oli-quality-summary": {
    reportKey: "oli-quality-summary", reportVersion: null,
    requiredSources: [OLI], optionalSources: [],
    sourceOwner: "scheduler-v2", materializationOwner: "serve:derive-durable",
    grain: "account", freshness: { maxAgeHours: 24, coverage: "D-1" },
    provenanceFields: ["source_refreshed_at"], lkgPolicy: "derive-fresh-each-read",
    regionalScheduling: "on-demand", capability: REPORT_CAPABILITIES["oli-quality-summary"],
    serveMode: "derive-at-serve", bucket: "B", pageOpenWrite: false, clientOpenTriggeredWrite: false,
    notes: "Account-wide OLI quality summary; pure read-derive, never stored.",
  },
  "listing-health-v3": {
    reportKey: "listing-health-v3", reportVersion: vTag("listing-health-v3"),
    requiredSources: [LISTINGS, LISTINGS_RAW, FBA], optionalSources: [OLI, CATALOG],
    sourceOwner: "scheduler-v2", materializationOwner: "scheduler-v2:v3-shadow",
    grain: "account", freshness: { maxAgeHours: 24, coverage: "latest-snapshot" },
    provenanceFields: ["inventory", "salesWindowStatus", "coverage", "evidence"], lkgPolicy: "serve-last-known-good",
    regionalScheduling: "shadow", capability: REPORT_CAPABILITIES["listing-health-v3"],
    serveMode: "derive-at-serve", bucket: "B", pageOpenWrite: false, clientOpenTriggeredWrite: false,
    notes: "SHADOW ingestion writes durable per-account aliases; serve derives read-only from them + durable OLI. UI flag LISTING_HEALTH_V3 is OFF.",
  },
  // ----- reports with NO live scheduler owner: materialized only by an explicit user Refresh (DataDoe) today. Declared
  //       honestly as materializationOwner="manual-refresh" so the gap is visible + a future move is reviewable. -----
  "sales": {
    reportKey: "sales", reportVersion: null,
    requiredSources: [OLI], optionalSources: [ADS],
    sourceOwner: "manual-refresh", materializationOwner: "manual-refresh",
    grain: "account", freshness: { maxAgeHours: 24, coverage: "D-1" },
    provenanceFields: ["source_refreshed_at"], lkgPolicy: "waiting-if-missing",
    regionalScheduling: "on-demand", capability: REPORT_CAPABILITIES["sales"],
    serveMode: "read-snapshot-else-waiting", bucket: "D", pageOpenWrite: false, clientOpenTriggeredWrite: false,
    notes: "Multi-account dashboard aggregate; no live scheduler owner -> only a user Refresh (DataDoe) materializes it.",
  },
  "reconciliation": {
    reportKey: "reconciliation", reportVersion: vTag("reconciliation"),
    requiredSources: [OLI, SETTLEMENTS, CATALOG], optionalSources: [],
    sourceOwner: "manual-refresh", materializationOwner: "manual-refresh",
    grain: "account", freshness: { maxAgeHours: 168, coverage: "6-month" },
    provenanceFields: ["source_refreshed_at"], lkgPolicy: "waiting-if-missing",
    regionalScheduling: "on-demand", capability: REPORT_CAPABILITIES["reconciliation"],
    serveMode: "read-snapshot-else-waiting", bucket: "D", pageOpenWrite: false, clientOpenTriggeredWrite: false,
    notes: "registry enabled:false; materialized only by a user Refresh (6 monthly settlement batches, DataDoe).",
  },
  "sku-pl": {
    reportKey: "sku-pl", reportVersion: vTag("sku-pl"),
    requiredSources: [PROFIT_BY_SKU], optionalSources: [OLI, CATALOG, ADS],
    sourceOwner: "manual-refresh", materializationOwner: "manual-refresh",
    grain: "account", freshness: { maxAgeHours: 168, coverage: "window" },
    provenanceFields: ["source_refreshed_at"], lkgPolicy: "waiting-if-missing",
    regionalScheduling: "on-demand", capability: REPORT_CAPABILITIES["sku-pl"],
    serveMode: "read-snapshot-else-waiting", bucket: "D", pageOpenWrite: false, clientOpenTriggeredWrite: false,
    notes: "registry enabled:false; user-Refresh only.",
  },
  "keyword-rank": {
    reportKey: "keyword-rank", reportVersion: vTag("keyword-rank"),
    requiredSources: [SQP_WEEKLY, CATALOG], optionalSources: [SQP_MONTHLY],
    sourceOwner: "manual-refresh", materializationOwner: "manual-refresh",
    grain: "account", freshness: { maxAgeHours: 168, coverage: "window" },
    provenanceFields: ["source_refreshed_at"], lkgPolicy: "waiting-if-missing",
    regionalScheduling: "shadow", capability: REPORT_CAPABILITIES["keyword-rank"],
    serveMode: "read-snapshot-else-waiting", bucket: "D", pageOpenWrite: false, clientOpenTriggeredWrite: false,
    notes: "Search Query Performance; enabled:false + shadow cycle only; user-Refresh materializes it.",
  },
  "content-changes": {
    reportKey: "content-changes", reportVersion: vTag("content-changes"),
    requiredSources: [CONTENT, CATALOG], optionalSources: [],
    sourceOwner: "manual-refresh", materializationOwner: "manual-refresh",
    grain: "account", freshness: { maxAgeHours: 168, coverage: "window" },
    provenanceFields: ["source_refreshed_at"], lkgPolicy: "waiting-if-missing",
    regionalScheduling: "on-demand", capability: REPORT_CAPABILITIES["content-changes"],
    serveMode: "read-snapshot-else-waiting", bucket: "D", pageOpenWrite: false, clientOpenTriggeredWrite: false,
    notes: "registry enabled:false; user-Refresh only.",
  },
  "sales-movers": {
    reportKey: "sales-movers", reportVersion: vTag("sales-movers"),
    requiredSources: [SALES_TRAFFIC, CATALOG], optionalSources: [PROFIT_BY_SKU, FBA, ADS],
    sourceOwner: "manual-refresh", materializationOwner: "manual-refresh",
    grain: "account", freshness: { maxAgeHours: 168, coverage: "7d-compare" },
    provenanceFields: ["source_refreshed_at", "salesLatestDate"], lkgPolicy: "waiting-if-missing",
    regionalScheduling: "shadow", capability: REPORT_CAPABILITIES["sales-movers"],
    serveMode: "read-snapshot-else-waiting", bucket: "D", pageOpenWrite: false, clientOpenTriggeredWrite: false,
    notes: "enabled:false + shadow cycle; user-Refresh materializes it.",
  },
  "listing-health": {
    reportKey: "listing-health", reportVersion: vTag("listing-health"),
    requiredSources: [LISTINGS, LISTINGS_RAW, PROFIT_BY_SKU, FBA, CATALOG], optionalSources: [],
    sourceOwner: "manual-refresh", materializationOwner: "manual-refresh",
    grain: "account", freshness: { maxAgeHours: 168, coverage: "latest-snapshot" },
    provenanceFields: ["source_refreshed_at"], lkgPolicy: "waiting-if-missing",
    regionalScheduling: "on-demand", capability: REPORT_CAPABILITIES["listing-health"],
    serveMode: "read-snapshot-else-waiting", bucket: "D", pageOpenWrite: false, clientOpenTriggeredWrite: false,
    notes: "v1 Listing Health; enabled:false; user-Refresh only. (v3 is the scheduled successor, UI-off.)",
  },
  "buy-box-loss": {
    reportKey: "buy-box-loss", reportVersion: vTag("buy-box-loss"),
    requiredSources: [PROFIT_BY_SKU, OLI, FBA, CATALOG], optionalSources: [],
    sourceOwner: "manual-refresh", materializationOwner: "manual-refresh",
    grain: "account", freshness: { maxAgeHours: 168, coverage: "window" },
    provenanceFields: ["source_refreshed_at"], lkgPolicy: "waiting-if-missing",
    regionalScheduling: "on-demand", capability: REPORT_CAPABILITIES["buy-box-loss"],
    serveMode: "read-snapshot-else-waiting", bucket: "D", pageOpenWrite: false, clientOpenTriggeredWrite: false,
    notes: "enabled:false; user-Refresh only.",
  },
  "ppc-performance": {
    reportKey: "ppc-performance", reportVersion: vTag("ppc-performance"),
    requiredSources: [OLI, CATALOG], optionalSources: [ADS],
    sourceOwner: "scheduler-v2", materializationOwner: "manual-refresh",
    grain: "account", freshness: { maxAgeHours: 168, coverage: "window" },
    provenanceFields: ["source_refreshed_at"], lkgPolicy: "waiting-if-missing",
    regionalScheduling: "shadow", capability: REPORT_CAPABILITIES["ppc-performance"],
    serveMode: "read-snapshot-else-waiting", bucket: "D", pageOpenWrite: false, clientOpenTriggeredWrite: false,
    notes: "Ads source IS scheduled; the ppc-performance snapshot itself has no live publisher (superseded by the Campaign Ads workspace view).",
  },
  "listing-optimizer": {
    reportKey: "listing-optimizer", reportVersion: vTag("listing-optimizer"),
    requiredSources: [SQP_WEEKLY, CATALOG], optionalSources: [OLI],
    sourceOwner: "manual-refresh", materializationOwner: "manual-refresh",
    grain: "account", freshness: { maxAgeHours: 168, coverage: "window" },
    provenanceFields: ["source_refreshed_at"], lkgPolicy: "waiting-if-missing",
    regionalScheduling: "shadow", capability: REPORT_CAPABILITIES["listing-optimizer"],
    serveMode: "read-snapshot-else-waiting", bucket: "D", pageOpenWrite: false, clientOpenTriggeredWrite: false,
    notes: "enabled:false + shadow cycle; user-Refresh only.",
  },
});

// The NON_REPORT actions that must NOT appear in the materialization registry (they are utilities/directories/admin).
export const NON_REPORT_ACTIONS = Object.freeze(
  Object.entries(REPORT_CAPABILITIES).filter(([, c]) => c === CAPABILITY.NON_REPORT).map(([a]) => a),
);

/**
 * Pure validator (fail-closed). Returns { ok:true } or throws with a precise message. Asserts:
 *  1. every REPORT capability (non NON_REPORT) has exactly one materialization entry;
 *  2. no entry exists for a NON_REPORT / unknown action;
 *  3. every entry declares ALL required fields with values from the controlled vocabularies;
 *  4. every entry has a BACKEND materialization owner (never page-open-only) + a non-empty required-source list;
 *  5. each entry's declared capability equals REPORT_CAPABILITIES[action];
 *  6. where the reportKey has a REPORT_DERIVATION, reportVersion matches its snapshotVersion (cross-check);
 *  7. where the reportKey has a REPORT_SOURCE_CONTRACT, every OWNED contract sourceKey is declared as a dependency
 *     (required OR optional) -- the report must not omit a source its own contract fetches. (Derived deps like OLI/
 *     Catalog may additionally be declared even when the contract does not own them.)
 *  8. clientOpenTriggeredWrite is a boolean.
 *  9. write-flag <-> serve-mode/owner consistency: pageOpenWrite:true IFF serveMode==="self-heal-write-on-read" IFF
 *     materializationOwner==="serve:self-heal" (a page-open write can never hide behind a read-looking declaration).
 * 10. a page-open write is allowed ONLY for a report in PAGE_OPEN_WRITE_GRANDFATHERED, and a client-open-triggered
 *     write is allowed for NONE -- so a NEW report cannot ship either kind of browser-triggered write.
 * 11. the write allowlist stays in EXACT lockstep with the declared flags (the pageOpenWrite:true set EQUALS
 *     PAGE_OPEN_WRITE_GRANDFATHERED; no report declares clientOpenTriggeredWrite:true) -- so the grandfather can only
 *     SHRINK as serve paths are made read-only, never grow.
 */
export function validateReportMaterializationRegistry({
  capabilities = REPORT_CAPABILITIES, capabilityEnum = CAPABILITY,
  derivations = REPORT_DERIVATIONS, sourceContracts = REPORT_SOURCE_CONTRACTS,
  registry = REPORT_MATERIALIZATION,
} = {}) {
  const problems = [];
  const reportActions = Object.entries(capabilities).filter(([, c]) => c !== capabilityEnum.NON_REPORT).map(([a]) => a);
  const reportSet = new Set(reportActions);

  // 1. coverage: every report capability has an entry.
  for (const a of reportActions) if (!(a in registry)) problems.push(`report action "${a}" has a capability but NO report-materialization entry (a new report must declare one)`);
  // 2. no stray / NON_REPORT entries.
  for (const a of Object.keys(registry)) {
    if (!(a in capabilities)) problems.push(`materialization entry "${a}" is not a registered report action`);
    else if (!reportSet.has(a)) problems.push(`materialization entry "${a}" is a NON_REPORT action and must not be declared`);
  }

  for (const [a, e] of Object.entries(registry)) {
    if (!reportSet.has(a)) continue; // already flagged
    // 3. all required fields present.
    for (const f of REQUIRED_DECLARATION_FIELDS) if (!(f in e)) problems.push(`"${a}" is missing required declaration field "${f}"`);
    // controlled vocabularies.
    if (e.sourceOwner != null && !SOURCE_OWNERS.includes(e.sourceOwner)) problems.push(`"${a}" sourceOwner "${e.sourceOwner}" is not an allowed value`);
    if (!MATERIALIZATION_OWNERS.includes(e.materializationOwner)) problems.push(`"${a}" materializationOwner "${e.materializationOwner}" is not a declared BACKEND materialization path`);
    if (!SERVE_MODES.includes(e.serveMode)) problems.push(`"${a}" serveMode "${e.serveMode}" is not an allowed value`);
    if (!GRAINS.includes(e.grain)) problems.push(`"${a}" grain "${e.grain}" is not an allowed value`);
    if (!LKG_POLICIES.includes(e.lkgPolicy)) problems.push(`"${a}" lkgPolicy "${e.lkgPolicy}" is not an allowed value`);
    if (!REGIONAL_SCHEDULING.includes(e.regionalScheduling)) problems.push(`"${a}" regionalScheduling "${e.regionalScheduling}" is not an allowed value`);
    if (typeof e.pageOpenWrite !== "boolean") problems.push(`"${a}" pageOpenWrite must be a boolean (does a plain GET write a snapshot?)`);
    // 4. a backend materialization path + a real required-source list + shape.
    if (!Array.isArray(e.requiredSources) || e.requiredSources.length === 0) problems.push(`"${a}" must declare at least one required durable source`);
    if (!Array.isArray(e.optionalSources)) problems.push(`"${a}" optionalSources must be an array`);
    if (!e.freshness || typeof e.freshness !== "object" || !("maxAgeHours" in e.freshness) || !("coverage" in e.freshness)) problems.push(`"${a}" freshness must declare { maxAgeHours, coverage }`);
    if (!Array.isArray(e.provenanceFields) || e.provenanceFields.length === 0) problems.push(`"${a}" must declare at least one provenance field (no dash without a machine-readable reason)`);
    // 5. capability consistency.
    if (e.capability !== capabilities[a]) problems.push(`"${a}" declares capability "${e.capability}" but REPORT_CAPABILITIES says "${capabilities[a]}"`);
    // 6. reportVersion cross-check (only where a derivation exists).
    const der = derivations[e.reportKey];
    if (der && der.snapshotVersion && e.reportVersion && e.reportVersion !== der.snapshotVersion) {
      problems.push(`"${a}" reportVersion "${e.reportVersion}" != REPORT_DERIVATIONS["${e.reportKey}"].snapshotVersion "${der.snapshotVersion}"`);
    }
    // 7. every OWNED contract sourceKey must be a declared dependency (required OR optional); extra derived deps are ok.
    const contract = sourceContracts[e.reportKey];
    if (contract) {
      const declared = new Set([...(e.requiredSources || []), ...(e.optionalSources || [])]);
      for (const cs of new Set(contract.map((c) => c.sourceKey))) if (!declared.has(cs)) {
        problems.push(`"${a}" omits contract-owned source "${cs}" from its declared dependencies (${[...declared].join(",")})`);
      }
    }
    // 8. clientOpenTriggeredWrite is a boolean (does a browser page-open/converge effect call the WRITE endpoint?).
    if (typeof e.clientOpenTriggeredWrite !== "boolean") problems.push(`"${a}" clientOpenTriggeredWrite must be a boolean`);
    // 9. write-flag <-> serve-mode consistency (biconditional): a page-open write is EXACTLY a self-heal serve, so no
    //    report can hide a write behind a read-looking serve mode, nor claim a self-heal serve while flagging read-only.
    //    (The owner is NOT biconditional: "daily" is a legit hybrid -- ALL-brand is scheduler-materialized, so its
    //    owner is scheduler-v2:priority, while its named-brand read still self-heals+writes, so pageOpenWrite=true. But
    //    a serve:self-heal OWNER always writes on read, so that direction IS enforced.)
    const selfHealMode = e.serveMode === "self-heal-write-on-read";
    if (e.pageOpenWrite === true && !selfHealMode) problems.push(`"${a}" pageOpenWrite=true but serveMode is "${e.serveMode}" (a page-open write must serve via self-heal-write-on-read)`);
    if (e.pageOpenWrite === false && selfHealMode) problems.push(`"${a}" serveMode is self-heal-write-on-read but pageOpenWrite=false (a self-heal serve DOES write on a read miss)`);
    if (e.materializationOwner === "serve:self-heal" && e.pageOpenWrite !== true) problems.push(`"${a}" materializationOwner is serve:self-heal but pageOpenWrite is not true (a self-heal owner writes on a read miss)`);
    // 10. a page-open / client-open write is allowed ONLY for a grandfathered report -> a NEW report is structurally
    //     prevented from shipping either kind of browser-triggered write.
    if (e.pageOpenWrite === true && !PAGE_OPEN_WRITE_GRANDFATHERED.includes(a)) {
      problems.push(`"${a}" has pageOpenWrite=true but is NOT in PAGE_OPEN_WRITE_GRANDFATHERED -- a new report may not depend on a page-open snapshot write; make its GET read-only (scheduler-materialized) instead`);
    }
    if (e.clientOpenTriggeredWrite === true && !CLIENT_OPEN_TRIGGERED_WRITE_GRANDFATHERED.includes(a)) {
      problems.push(`"${a}" has clientOpenTriggeredWrite=true but is NOT in CLIENT_OPEN_TRIGGERED_WRITE_GRANDFATHERED (which is empty) -- a browser page-open/converge effect must never call the write endpoint; poll read-only instead`);
    }
  }

  // 11. the write allowlists must stay in EXACT lockstep with the declared write flags -- the set of reports whose
  //     pageOpenWrite is true must EQUAL PAGE_OPEN_WRITE_GRANDFATHERED (so the allowlist can neither grow silently nor
  //     keep a stale entry once a report is made read-only), and clientOpenTriggeredWrite must be true for NONE.
  const declaredPageOpenWriters = Object.entries(registry).filter(([a, e]) => reportSet.has(a) && e.pageOpenWrite === true).map(([a]) => a).sort();
  const grandfathered = [...PAGE_OPEN_WRITE_GRANDFATHERED].sort();
  if (JSON.stringify(declaredPageOpenWriters) !== JSON.stringify(grandfathered)) {
    problems.push(`PAGE_OPEN_WRITE_GRANDFATHERED [${grandfathered.join(",")}] must EQUAL the set of reports declaring pageOpenWrite:true [${declaredPageOpenWriters.join(",")}] -- update BOTH in lockstep (remove a report from the allowlist only when its GET is made read-only)`);
  }
  for (const a of PAGE_OPEN_WRITE_GRANDFATHERED) if (!reportSet.has(a)) problems.push(`PAGE_OPEN_WRITE_GRANDFATHERED lists "${a}", which is not a registered report action`);
  const declaredClientWriters = Object.entries(registry).filter(([a, e]) => reportSet.has(a) && e.clientOpenTriggeredWrite === true).map(([a]) => a).sort();
  if (declaredClientWriters.length !== 0) {
    problems.push(`no report may declare clientOpenTriggeredWrite:true (Phase 3 made every browser converge/poll read-only); offenders: [${declaredClientWriters.join(",")}]`);
  }

  if (problems.length) {
    const err = new Error(`report-materialization registry invalid (${problems.length}):\n - ${problems.join("\n - ")}`);
    err.problems = problems;
    throw err;
  }
  return { ok: true, reports: reportActions.length, pageOpenWriters: declaredPageOpenWriters.length };
}
