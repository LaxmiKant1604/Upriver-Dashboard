// Scheduler v2 -- TYPED, IMMUTABLE SOURCE DEPENDENCY REGISTRY (pure, ZERO I/O).
//
// ONE reviewed record per canonical source family. The registry is the single place that answers, for a
// source family: which DataDoe source id it is, whether it is seller-scoped or organization-wide, what its
// grain semantics are (dated / current-snapshot / weekly / monthly / whole-window), how it may be batched,
// which downstream dashboards consume it, how it is initially backfilled and incrementally refreshed, what
// its DataDoe AI-token class is (standard = 2 tokens / premium = 5), whether its per-cycle plan is STATIC
// (budget-freezable) or SIGNAL-DERIVED, and how its data is durably stored.
//
// FAIL CLOSED: every fetched family in REPORT_SOURCE_CONTRACTS and every derived Ads family MUST be
// registered, every registered record is cross-checked at module load against the executable contracts
// (source ids, consumers, seller-scope allowlist, tranche classification), and ANY unregistered or
// contradictory dependency THROWS at import time. Reading an unregistered key THROWS (typed
// UNREGISTERED_SOURCE) -- there is no default record and no default token price.
//
// This module never fetches anything and never changes a request identity: golden request_hash values are
// untouched (the registry only DESCRIBES the families the contracts already declare).

import { SOURCE_CONTRACTS, REPORT_SOURCE_REQUIREMENTS } from "../source-contracts.js";
import {
  REPORT_SOURCE_CONTRACTS, REPORT_DERIVED_SOURCE_KEYS, REPORT_DERIVED_ONLY, SELLER_SCOPED_REQUEST_KEYS,
} from "./report-source-contracts.js";
import { SOURCE_TRANCHE_ORDER } from "./source-tranche.js";

export const SOURCE_SCOPES = Object.freeze(["seller", "organization"]);
export const SOURCE_GRAINS = Object.freeze(["dated", "current-snapshot", "weekly", "monthly", "whole-window"]);
export const SOURCE_TOKEN_CLASSES = Object.freeze(["standard", "premium"]);
export const SOURCE_STORAGE_STRATEGIES = Object.freeze([
  "durable-history",   // canonical rows upserted into a durable typed table (rolling refresh; never re-export proven coverage)
  "durable-snapshot",  // the latest VALIDATED current-state payload is pinned durably (failure preserves latest-good)
  "durable-ads",       // the existing durable Ads architecture (ads_daily_source_rows / ad_daily_metrics + coverage windows)
  "cycle-cache",       // the per-cycle source_export_cache (TTL) + report LKG snapshots (pre-durable families)
]);
export const SOURCE_PLANNING_MODES = Object.freeze(["static", "signal-derived"]);
export const SOURCE_BATCHING_MODES = Object.freeze([
  "stable-batch",   // approved for <=5-account stable batching (requires a SELLER_SCOPED_REQUEST_KEYS contract)
  "per-account",    // seller-scoped but fetched one account per export by its current approved contracts
  "organization",   // organization-wide: ONE export per organization/window, never per seller
]);

// The DataDoe premium tables among the registered families (from source discovery `isPremium` / the
// data-scheme): Profit by SKU & Date, Listings (COGS-enriched), FBA Inventory Health. The raw Listings twin
// (listings-raw) is standard. Everything else registered here is standard (2 tokens).
const rec = (r) => Object.freeze({
  ...r,
  usedByReports: Object.freeze([...r.usedByReports].sort()),
  usedByDashboards: Object.freeze([...r.usedByDashboards].sort()),
  batching: Object.freeze({ ...r.batching }),
  initialBackfill: Object.freeze({ ...r.initialBackfill }),
  incrementalRefresh: Object.freeze({ ...r.incrementalRefresh }),
});

// NOTE on usedByReports vs usedByDashboards: usedByReports is the DIRECT consumer set and must EXACTLY equal
// what REPORT_SOURCE_REQUIREMENTS declares (cross-checked below). usedByDashboards additionally includes the
// SNAPSHOT-DERIVED dashboards (brand-view / priority-feed) that read a direct consumer's saved snapshot, so it
// answers the operator question "which dashboards stop updating when this source stops" (Data Sync Center
// "Used by" list). Both are validated: dashboards must be a superset of reports, and every extra entry must be
// reachable through REPORT_SOURCE_REQUIREMENTS' report->report dependencies (transitive closure; no free text).
export const SOURCE_REGISTRY = Object.freeze([
  rec({
    sourceKey: "order-line-items",
    dataDoeSourceId: "89b27535d27c2a94db5ae39af4717f542624ff4df7802fd633e16c78674a1778",
    scope: "seller",
    grain: "dated",
    batching: { mode: "stable-batch", maxAccountsPerExport: 5, marketplaceSafe: true },
    usedByReports: ["brand-sales", "daily-reporting", "reconciliation", "fba-plan", "buy-box-loss", "returns-leakage", "ppc-performance"],
    usedByDashboards: ["brand-sales", "brand-view", "daily-reporting", "reconciliation", "fba-plan", "buy-box-loss", "returns-leakage", "ppc-performance", "priority-feed"],
    // Authorized durable OLI backfill: the complete missing window per <=5-seller batch (no 7-day pre-slicing),
    // SPLIT into contiguous chunks no larger than the proven application safety cap (MAX_OLI_EXPORT_WINDOW_DAYS).
    // A GENUINELY FIXED calendar start (2025-01-01), so the authorized window is [2025-01-01, asOf] for ANY asOf
    // and the start NEVER drifts as the month rolls over (a window-days-from-month-start policy would move the
    // start forward every month). [2025-01-01, asOf] is a SUPERSET of the longest executable Daily/Brand View
    // contract window (brand-sales monthStart(asOf)-420, Daily monthBack(asOf,5)), so it fully covers both.
    // Proven HISTORY before the rolling refresh window is never re-exported; the trailing incrementalRefresh
    // window (below) IS re-pulled every run so recent-day corrections are captured.
    initialBackfill: { kind: "fixed-start", start: "2025-01-01" },
    // The trailing window DataDoe still restates: re-exported every run (replace-matching-rows) via the bucket
    // planner's coverage clip, so late corrections to recent days are always captured.
    incrementalRefresh: { kind: "rolling-window-days", days: 7, upsert: "replace-matching-rows" },
    tokenClass: "standard",
    planning: "static",
    storage: "durable-history",
  }),
  rec({
    sourceKey: "product-catalog",
    dataDoeSourceId: "68d2de238e",
    scope: "organization",
    grain: "current-snapshot",
    batching: { mode: "organization", maxAccountsPerExport: null, marketplaceSafe: true },
    usedByReports: ["brand-sales", "daily-reporting", "reconciliation", "fba-plan", "keyword-rank", "content-changes", "sales-movers", "listing-health", "buy-box-loss", "returns-leakage", "ppc-performance", "listing-optimizer"],
    usedByDashboards: ["brand-sales", "brand-view", "daily-reporting", "reconciliation", "fba-plan", "keyword-rank", "content-changes", "sales-movers", "listing-health", "buy-box-loss", "returns-leakage", "ppc-performance", "listing-optimizer", "priority-feed"],
    initialBackfill: { kind: "current-only" },
    // Once per day per ORGANIZATION -- never once per dashboard or per seller. A failed refresh preserves the
    // latest VALIDATED catalog (durable-snapshot semantics).
    incrementalRefresh: { kind: "daily-snapshot", perOrganization: true },
    tokenClass: "standard",
    planning: "static",
    storage: "durable-snapshot",
  }),
  rec({
    sourceKey: "settlements",
    dataDoeSourceId: "732dac689a6545697c2f2e36c61b2c9e93187053bcce2999914183c6f490df27",
    scope: "seller",
    grain: "dated",
    batching: { mode: "per-account", maxAccountsPerExport: 1, marketplaceSafe: true },
    usedByReports: ["reconciliation", "returns-leakage"],
    usedByDashboards: ["reconciliation", "returns-leakage", "priority-feed"],
    initialBackfill: { kind: "window-days", days: 90 },
    incrementalRefresh: { kind: "cycle-window" },
    tokenClass: "standard",
    planning: "static",
    storage: "cycle-cache",
  }),
  rec({
    sourceKey: "returns",
    dataDoeSourceId: "27c6fc0ec69648b5fed4612dbd9ccdfdeaaca6787f8f985c01266e4dc11f9038",
    scope: "seller",
    grain: "dated",
    batching: { mode: "per-account", maxAccountsPerExport: 1, marketplaceSafe: true },
    usedByReports: ["returns-leakage"],
    usedByDashboards: ["returns-leakage", "priority-feed"],
    initialBackfill: { kind: "window-days", days: 90 },
    incrementalRefresh: { kind: "cycle-window" },
    tokenClass: "standard",
    planning: "static",
    storage: "cycle-cache",
  }),
  rec({
    sourceKey: "profit-by-sku-date",
    dataDoeSourceId: "57a0cb319c10a395853afc0671579bf7ef0ff45d8a40c88ed9d2a5f61b4169a4",
    scope: "seller",
    grain: "dated",
    batching: { mode: "per-account", maxAccountsPerExport: 1, marketplaceSafe: true },
    usedByReports: ["sku-pl", "sales-movers", "listing-health", "buy-box-loss"],
    usedByDashboards: ["sku-pl", "sales-movers", "listing-health", "buy-box-loss", "priority-feed"],
    initialBackfill: { kind: "window-days", days: 90 },
    incrementalRefresh: { kind: "cycle-window" },
    tokenClass: "premium",
    // sales-movers:ads windows are derived from the sales probe's validated latest reported date, so this
    // family can gain SIGNAL-DERIVED request hashes a static pre-plan cannot enumerate.
    planning: "signal-derived",
    storage: "cycle-cache",
  }),
  rec({
    sourceKey: "sales-traffic-asin-date",
    dataDoeSourceId: "401ffcd7e5",
    scope: "seller",
    grain: "dated",
    batching: { mode: "per-account", maxAccountsPerExport: 1, marketplaceSafe: true },
    usedByReports: ["sales-movers"],
    usedByDashboards: ["sales-movers", "priority-feed"],
    initialBackfill: { kind: "window-days", days: 28 },
    incrementalRefresh: { kind: "cycle-window" },
    tokenClass: "standard",
    // The probe window is static, but the downstream traffic windows derive from the probe's validated
    // latest reported date (staged dependency) -- signal-derived hashes.
    planning: "signal-derived",
    storage: "cycle-cache",
  }),
  rec({
    sourceKey: "listings",
    dataDoeSourceId: "ba689c05d7f7cee1a1690990c28995680a0654b7ed258230f4173d61bbcd1ab3",
    scope: "seller",
    grain: "current-snapshot",
    batching: { mode: "per-account", maxAccountsPerExport: 1, marketplaceSafe: true },
    usedByReports: ["fba-plan", "listing-health"],
    usedByDashboards: ["fba-plan", "listing-health", "priority-feed"],
    initialBackfill: { kind: "current-only" },
    incrementalRefresh: { kind: "daily-snapshot", perOrganization: false },
    tokenClass: "premium",
    planning: "static",
    storage: "cycle-cache",
  }),
  rec({
    sourceKey: "listings-raw",
    dataDoeSourceId: "6ea445cdc459f9fbb9517c5c009384da60ef31a1e70d4de9187ea3d4c28535c4",
    scope: "seller",
    grain: "current-snapshot",
    batching: { mode: "per-account", maxAccountsPerExport: 1, marketplaceSafe: true },
    usedByReports: ["listing-health"],
    usedByDashboards: ["listing-health", "priority-feed"],
    initialBackfill: { kind: "current-only" },
    incrementalRefresh: { kind: "daily-snapshot", perOrganization: false },
    tokenClass: "standard",
    planning: "static",
    storage: "cycle-cache",
  }),
  rec({
    sourceKey: "fba-inventory-health",
    dataDoeSourceId: "44fc5ba0ce81a7807601f6d7a9b8b7aaec64be4c7e046ea30dc6864d1a4aa823",
    scope: "seller",
    grain: "current-snapshot",
    batching: { mode: "per-account", maxAccountsPerExport: 1, marketplaceSafe: true },
    usedByReports: ["fba-plan", "sales-movers", "listing-health", "buy-box-loss"],
    usedByDashboards: ["fba-plan", "sales-movers", "listing-health", "buy-box-loss", "brand-view", "priority-feed"],
    // The latest VALIDATED current snapshot is what matters; historical inventory is never repeatedly
    // backfilled. Inventory ASINs join the SAME durable catalog brand map (never a second brand source).
    initialBackfill: { kind: "current-only" },
    incrementalRefresh: { kind: "daily-snapshot", perOrganization: false },
    tokenClass: "premium",
    planning: "static",
    storage: "durable-snapshot",
  }),
  rec({
    sourceKey: "content-changes",
    dataDoeSourceId: "aec3d5976911a7a80110c08801a741e4f0a25dd997d639f5d918284d905a4758",
    scope: "seller",
    grain: "whole-window",
    batching: { mode: "per-account", maxAccountsPerExport: 1, marketplaceSafe: true },
    usedByReports: ["content-changes"],
    usedByDashboards: ["content-changes"],
    initialBackfill: { kind: "whole-window" },
    incrementalRefresh: { kind: "cycle-window" },
    tokenClass: "standard",
    planning: "static",
    storage: "cycle-cache",
  }),
  rec({
    sourceKey: "sqp-weekly",
    dataDoeSourceId: "81aa5b4cc248bb70de405b9ff9d51290b9232f84570d76ba2a1289b67b6595fb",
    scope: "seller",
    grain: "weekly",
    batching: { mode: "per-account", maxAccountsPerExport: 1, marketplaceSafe: true },
    usedByReports: ["keyword-rank", "listing-optimizer"],
    usedByDashboards: ["keyword-rank", "listing-optimizer", "priority-feed"],
    initialBackfill: { kind: "window-days", days: 84 },
    incrementalRefresh: { kind: "cycle-window" },
    tokenClass: "standard",
    planning: "static",
    storage: "cycle-cache",
  }),
  rec({
    sourceKey: "sqp-monthly",
    dataDoeSourceId: "df4160ff8e1add239172a69ebd6c8abfec7116ee4a17720983757b1b55599830",
    scope: "seller",
    grain: "monthly",
    batching: { mode: "per-account", maxAccountsPerExport: 1, marketplaceSafe: true },
    usedByReports: ["keyword-rank"],
    usedByDashboards: ["keyword-rank"],
    initialBackfill: { kind: "window-days", days: 365 },
    incrementalRefresh: { kind: "cycle-window" },
    tokenClass: "standard",
    // The monthly fallback is DATA-DEPENDENT (activated only when the weekly signal proves it necessary), so
    // its hashes cannot be enumerated by a static pre-plan.
    planning: "signal-derived",
    storage: "cycle-cache",
  }),
  // ---- Durable Ads families (fetched by the EXISTING durable Ads architecture, never by a Scheduler-v2
  // source job; REPORT_SOURCE_CONTRACTS therefore declares NO contract for them -- they are derived inputs). ----
  rec({
    sourceKey: "ads-campaign-date",
    dataDoeSourceId: "08cdc77d3d",
    scope: "seller",
    grain: "dated",
    batching: { mode: "per-account", maxAccountsPerExport: 1, marketplaceSafe: true },
    usedByReports: ["daily-reporting", "ppc-performance"],
    // Daily Reporting reads the CAMPAIGN grain (ad_daily_metrics). Brand View does NOT read this family.
    usedByDashboards: ["daily-reporting", "ppc-performance", "priority-feed"],
    initialBackfill: { kind: "window-days", days: 56 },
    incrementalRefresh: { kind: "rolling-window-days", days: 21, upsert: "replace-matching-rows" },
    tokenClass: "standard",
    planning: "static",
    storage: "durable-ads",
  }),
  rec({
    sourceKey: "ads-asin-date",
    dataDoeSourceId: "d0017e92fb089c2c8c3fe65f81d08666ecb4fe937ffbce9969ce2fc7d28c805c",
    scope: "seller",
    grain: "dated",
    batching: { mode: "per-account", maxAccountsPerExport: 1, marketplaceSafe: true },
    usedByReports: ["ppc-performance", "brand-view"],
    // Brand View reads the ASIN grain (asin-performance-v1) -- the ONLY Ads grain it reads; the campaign and
    // ASIN grains OVERLAP and are never summed together.
    usedByDashboards: ["ppc-performance", "brand-view", "priority-feed"],
    initialBackfill: { kind: "window-days", days: 60 },
    incrementalRefresh: { kind: "rolling-window-days", days: 21, upsert: "replace-matching-rows" },
    tokenClass: "standard",
    planning: "static",
    storage: "durable-ads",
  }),
  rec({
    sourceKey: "ads-targeting-date",
    dataDoeSourceId: "bbba3d213ac78ccbaf22cfa68eecb3f475641f49da26d51d1ac36446310051e3",
    scope: "seller",
    grain: "dated",
    batching: { mode: "per-account", maxAccountsPerExport: 1, marketplaceSafe: true },
    usedByReports: ["ppc-performance"],
    usedByDashboards: ["ppc-performance", "priority-feed"],
    initialBackfill: { kind: "window-days", days: 56 },
    incrementalRefresh: { kind: "rolling-window-days", days: 21, upsert: "replace-matching-rows" },
    tokenClass: "standard",
    planning: "static",
    storage: "durable-ads",
  }),
  rec({
    sourceKey: "ads-search-terms-date",
    dataDoeSourceId: "e94e9671989ce4aa2814ac729807c7ddcc1cc47a71ebcd75d9fe661ed80335be",
    scope: "seller",
    grain: "dated",
    batching: { mode: "per-account", maxAccountsPerExport: 1, marketplaceSafe: true },
    usedByReports: ["ppc-performance"],
    usedByDashboards: ["ppc-performance", "priority-feed"],
    initialBackfill: { kind: "window-days", days: 60 },
    incrementalRefresh: { kind: "rolling-window-days", days: 21, upsert: "replace-matching-rows" },
    tokenClass: "standard",
    planning: "static",
    storage: "durable-ads",
  }),
]);

const REGISTRY_BY_KEY = new Map(SOURCE_REGISTRY.map((r) => [r.sourceKey, r]));

// Typed fail-closed reader: an unregistered source family is a hard error, never a default record.
export function sourceRegistryEntry(sourceKey) {
  const key = String(sourceKey || "");
  const entry = REGISTRY_BY_KEY.get(key);
  if (!entry) {
    const err = new Error(`UNREGISTERED_SOURCE: source family "${key}" has no source-registry record; refusing (fail closed).`);
    err.code = "UNREGISTERED_SOURCE";
    throw err;
  }
  return entry;
}

// The DataDoe pricing reader for computeFrozenTrancheBudget: a definite boolean from the registry token
// class. Reads job.sourceKey ?? job.source_key; an unregistered family throws (no default price).
export function registryIsPremiumOf(job) {
  const key = job && typeof job === "object" ? (job.sourceKey ?? job.source_key ?? "") : "";
  return sourceRegistryEntry(key).tokenClass === "premium";
}

// The Data Sync Center "Used by" dashboard list (direct + snapshot-derived consumers).
export function dashboardsUsingSource(sourceKey) {
  return sourceRegistryEntry(sourceKey).usedByDashboards;
}

// A tranche's budget mode: its create/AI-token ceilings can be FROZEN before execution ONLY when EVERY
// member family's per-cycle plan is STATIC. A tranche containing any signal-derived family cannot enumerate
// its hashes up front, so it runs unbudgeted (the one-attempt-per-hash claim still bounds every create).
export function trancheBudgetMode(trancheSpec) {
  const keys = trancheSpec && Array.isArray(trancheSpec.sourceKeys) ? trancheSpec.sourceKeys : [];
  if (!keys.length) {
    throw new Error("trancheBudgetMode requires a tranche spec with a non-empty sourceKeys array (fail closed).");
  }
  return keys.every((k) => sourceRegistryEntry(k).planning === "static") ? "frozen" : "unbudgeted";
}

/* ------------------------------- module-load consistency (fail closed) ------------------------------- */

// Exported with INJECTABLE inputs so the regression suite can prove an unregistered or contradictory
// dependency genuinely fails closed. Production behavior is the zero-argument module-load invocation below;
// injected overrides exist ONLY for tests (they can never alter the frozen SOURCE_REGISTRY itself).
export function assertSourceRegistryConsistency(overrides = {}) {
  const {
    registry = SOURCE_REGISTRY,
    requirements = REPORT_SOURCE_REQUIREMENTS,
    canonicalContracts = SOURCE_CONTRACTS,
    reportContracts = REPORT_SOURCE_CONTRACTS,
    sellerScopedRequestKeys = SELLER_SCOPED_REQUEST_KEYS,
    trancheOrder = SOURCE_TRANCHE_ORDER,
    derivedSourceKeys = REPORT_DERIVED_SOURCE_KEYS,
    derivedOnly = REPORT_DERIVED_ONLY,
  } = overrides;
  const die = (msg) => { throw new Error(`source-registry consistency: ${msg} (fail closed).`); };

  const contractByKey = new Map(canonicalContracts.map((c) => [c.key, c]));
  const reportKeys = new Set(Object.keys(requirements));

  // The fetched families the report contracts actually declare.
  const fetched = new Set();
  const familiesByRequestKey = new Map();
  for (const [rk, contracts] of Object.entries(reportContracts)) {
    for (const c of contracts || []) {
      if (c && typeof c.sourceKey === "string" && c.sourceKey.trim() !== "") {
        fetched.add(c.sourceKey);
        if (c.requestKey) familiesByRequestKey.set(c.requestKey, c.sourceKey);
      }
    }
    if (!rk) die("blank report key in REPORT_SOURCE_CONTRACTS");
  }
  // The derived Ads families the contracts reference without fetching.
  const derived = new Set();
  for (const keys of Object.values(derivedSourceKeys)) for (const k of keys || []) derived.add(k);
  // brand-view's snapshot-derived requirement names ads-asin-date directly.
  for (const dep of requirements["brand-view"] || []) {
    if (!reportKeys.has(dep)) derived.add(dep);
  }

  // 1) COVERAGE: every fetched + derived family is registered; no registered family is unknown to the
  //    canonical contracts; each family appears at most once.
  const seen = new Set();
  for (const r of registry) {
    if (seen.has(r.sourceKey)) die(`source family "${r.sourceKey}" is registered twice`);
    seen.add(r.sourceKey);
    if (!contractByKey.has(r.sourceKey)) die(`registered family "${r.sourceKey}" has no canonical SOURCE_CONTRACTS entry`);
  }
  for (const k of fetched) if (!seen.has(k)) die(`fetched source family "${k}" is UNREGISTERED`);
  for (const k of derived) if (!seen.has(k)) die(`derived source family "${k}" is UNREGISTERED`);

  for (const r of registry) {
    const contract = contractByKey.get(r.sourceKey);

    // 2) ENUMS + shapes.
    if (!SOURCE_SCOPES.includes(r.scope)) die(`"${r.sourceKey}" scope "${r.scope}" is not a valid source scope`);
    if (!SOURCE_GRAINS.includes(r.grain)) die(`"${r.sourceKey}" grain "${r.grain}" is not a valid grain`);
    if (!SOURCE_TOKEN_CLASSES.includes(r.tokenClass)) die(`"${r.sourceKey}" tokenClass "${r.tokenClass}" is not a valid token class`);
    if (!SOURCE_STORAGE_STRATEGIES.includes(r.storage)) die(`"${r.sourceKey}" storage "${r.storage}" is not a valid storage strategy`);
    if (!SOURCE_PLANNING_MODES.includes(r.planning)) die(`"${r.sourceKey}" planning "${r.planning}" is not a valid planning mode`);
    if (!SOURCE_BATCHING_MODES.includes(r.batching.mode)) die(`"${r.sourceKey}" batching mode "${r.batching.mode}" is not valid`);

    // 3) SOURCE ID: the registered id must be one of the canonical contract's ids (short or long form).
    if (!contract.ids.includes(r.dataDoeSourceId)) {
      die(`"${r.sourceKey}" dataDoeSourceId does not match any canonical SOURCE_CONTRACTS id`);
    }

    // 4) DIRECT CONSUMERS: usedByReports must EXACTLY equal the reports whose REPORT_SOURCE_REQUIREMENTS
    //    declare this family (both directions -- a missing or invented consumer is a contradiction).
    const expected = Object.entries(requirements)
      .filter(([, deps]) => (deps || []).includes(r.sourceKey))
      .map(([reportKey]) => reportKey)
      .sort();
    const got = [...r.usedByReports].sort();
    if (JSON.stringify(expected) !== JSON.stringify(got)) {
      die(`"${r.sourceKey}" usedByReports [${got.join(", ")}] contradicts REPORT_SOURCE_REQUIREMENTS [${expected.join(", ")}]`);
    }

    // 5) DASHBOARDS: a superset of the direct reports; every EXTRA entry must be a snapshot-derived
    //    dashboard reachable from a direct consumer through REPORT_SOURCE_REQUIREMENTS report->report edges.
    const direct = new Set(r.usedByReports);
    for (const d of r.usedByDashboards) {
      if (direct.has(d)) continue;
      const deps = requirements[d];
      const reachable = Array.isArray(deps) && deps.some((dep) => direct.has(dep) || (requirements[dep] || []).some((dd) => direct.has(dd)));
      if (!reachable) die(`"${r.sourceKey}" usedByDashboards entry "${d}" is neither a direct consumer nor a snapshot-derived dashboard of one`);
    }
    for (const d of r.usedByReports) {
      if (!r.usedByDashboards.includes(d)) die(`"${r.sourceKey}" usedByDashboards is missing direct consumer "${d}"`);
    }

    // 6) SCOPE vs the executable seller-scope allowlist: a family with an approved cross-account batched
    //    contract MUST be seller-scoped, and only a stable-batch family may have one. Organization-wide
    //    means exactly that -- it can never be batchable by seller.
    const hasBatchedContract = sellerScopedRequestKeys.some((rk) => familiesByRequestKey.get(rk) === r.sourceKey);
    if (hasBatchedContract && r.scope !== "seller") die(`"${r.sourceKey}" has a seller-batched contract but is not seller-scoped`);
    if (hasBatchedContract && r.batching.mode !== "stable-batch") die(`"${r.sourceKey}" has a seller-batched contract but batching mode "${r.batching.mode}"`);
    if (!hasBatchedContract && r.batching.mode === "stable-batch") die(`"${r.sourceKey}" is stable-batch but has NO approved SELLER_SCOPED_REQUEST_KEYS contract`);
    if (r.scope === "organization" && r.batching.mode !== "organization") die(`"${r.sourceKey}" is organization-wide but not organization-batched`);
    if (r.batching.mode === "stable-batch" && r.batching.maxAccountsPerExport !== 5) die(`"${r.sourceKey}" stable-batch must cap at exactly 5 accounts per export`);

    // 7) STORAGE vs fetch path: a durable-ads family must NOT be a fetched Scheduler-v2 family (it is
    //    fetched by the durable Ads architecture), and vice versa every fetched family must not be durable-ads.
    if (r.storage === "durable-ads" && fetched.has(r.sourceKey)) die(`"${r.sourceKey}" is durable-ads but REPORT_SOURCE_CONTRACTS fetches it as a source job`);
    if (r.storage !== "durable-ads" && !fetched.has(r.sourceKey)) die(`"${r.sourceKey}" is not durable-ads yet no REPORT_SOURCE_CONTRACTS contract fetches it`);
  }

  // 8) TRANCHE COVERAGE: every tranche family is registered (the tranche order already cross-checks itself
  //    against the contracts, so together the three structures cannot drift apart).
  for (const t of trancheOrder) {
    for (const k of t.sourceKeys) if (!seen.has(k)) die(`tranche "${t.name}" family "${k}" is UNREGISTERED`);
  }

  // 9) DERIVED-ONLY dashboards must not be registered as sources.
  for (const k of derivedOnly) if (seen.has(k)) die(`derived-only dashboard "${k}" must not be registered as a source family`);

  return true;
}

// PRODUCTION module-load check: the real registry against the real contracts. Drift throws at import.
assertSourceRegistryConsistency();
