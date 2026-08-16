// The scheduled-sync registry — the single declarative source of truth for what
// the cron orchestrator syncs, how, and when.
//
// HONEST LIMITATION (by design): discovery here is DECLARATIVE, not reflective.
// A report is synced only if it has an entry in SYNC_REGISTRY *and* a matching
// adapter. There is no scan of arbitrary api/datadoe.js code — a new report joins
// the schedule by adding one entry plus one adapter, never by "magic" discovery.
//
// A registry entry:
//   reportKey       must equal the browser read key (api/datadoe.js action key)
//   reportVersion   must equal the browser reportVersion so paramsHashFor() yields
//                   the exact snapshot key the browser requests (exact-hit reads).
//   label           human name
//   domain          'ads' | 'report' | 'insight'
//   scheduleBucket  'us' | 'non-us' | 'both'
//   partition       'per-account' (one work item per account) | 'per-bucket' (ads)
//   snapshotMode    'replace-daily' (upsert one snapshot) | 'append-history' (ads upsert)
//   windowFor       ({ asOf, country }) => params object ({from,to} | {to} | {asOf})
//   adapter         adapter id under lib/server/sync/adapters/*
//   validate        (payload) => true | string(error message); blocks save on failure
//   dependencies    reportKeys that must run first
//   retentionDays   how long saved snapshots are kept (null = keep, e.g. ads history)
//   enabled         false => declared but not yet wired (follow-up)

export const SCHEDULE_BUCKETS = { US: "us", NON_US: "non-us" };

// Desired Scheduler v2 schedule after production approval:
//   non-us -> 02:00 UTC (07:30 IST); us -> 10:30 UTC (16:00 IST).
// Automatic production triggers are temporarily removed while Scheduler v2 is
// unfinished; scripts/test-sync.mjs asserts that pause remains in force.
export const SCHEDULE_UTC = { "non-us": "02:00", us: "10:30" };
export const SCHEDULE_CRON = { "non-us": "0 2 * * *", us: "30 10 * * *" };

export const ADS_SOURCE_KEYS = [
  "campaign-performance-v1",
  "asin-performance-v1",
  "keyword-targeting-performance-v1",
  "search-terms-performance-v1",
];

/* ------------------------------------------------------------ date helpers */
// Pure, UTC, string-in/string-out. Kept local so the registry has no I/O deps.

function pad(n) { return String(n).padStart(2, "0"); }

export function addDaysStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function monthStartStr(dateStr) {
  return `${String(dateStr).slice(0, 7)}-01`;
}

/* ------------------------------------------------------------ bucketing */

/**
 * Classify an account by its marketplace country. Metadata-driven, never by
 * account-name string matching. Empty/unknown country is 'unknown' and must be
 * flagged + skipped by the orchestrator, never coerced into us/non-us.
 */
export function bucketForCountry(country) {
  const code = String(country || "").trim().toUpperCase();
  if (!code) return "unknown";
  return code === "US" ? "us" : "non-us"; // CA/AU/IN/EU/GB/... => non-us
}

/**
 * The runAdsSync(countries) arguments for a bucket. 'us' is just ['US']; 'non-us'
 * covers the managed non-US countries plus the 'OTHER' sentinel so any unmanaged
 * (but known) country is still swept.
 */
export function countriesForBucket(bucket) {
  return bucket === "us"
    ? { groups: [["US"]] }
    : { groups: [["IN", "CA", "AU"], "OTHER"] };
}

/* ------------------------------------------------------------ entry factories */

function ads(sourceKey) {
  return {
    reportKey: `ads:${sourceKey}`,
    reportVersion: sourceKey, // ads history is keyed in ads_daily_source_rows, not report_snapshots
    label: `Ads — ${sourceKey}`,
    domain: "ads",
    scheduleBucket: "both",
    partition: "per-bucket",
    snapshotMode: "append-history",
    windowFor: () => ({}), // runAdsSync owns its own initial/daily/monthly windows
    adapter: "ads",
    validate: () => true,
    dependencies: [],
    retentionDays: null, // Ads daily history is preserved (rolling correction upserts)
    sourceKey,
    enabled: true,
  };
}

function report({ reportKey, reportVersion, label, domain = "report", windowFor, adapter, validate, retentionDays = 30, dependencies = [], enabled }) {
  return {
    reportKey, reportVersion, label, domain,
    scheduleBucket: "both",
    partition: "per-account",
    snapshotMode: "replace-daily",
    windowFor, adapter,
    validate: validate || (() => true),
    dependencies, retentionDays, enabled,
  };
}

/* ------------------------------------------------------------ the registry */

export const SYNC_REGISTRY = [
  // --- Ads (per-bucket, append-history, via runAdsSync). Enabled. ---
  ...ADS_SOURCE_KEYS.map(ads),

  // --- Reports wired and enabled this pass (per-account, replace-daily). ---
  report({
    reportKey: "brand-sales", reportVersion: "brand-sales-shared-v1", label: "Dashboard",
    // Matches the browser window (App.jsx ~1285): 420 days back from month start.
    windowFor: ({ asOf }) => ({ from: addDaysStr(monthStartStr(asOf), -420), to: asOf }),
    adapter: "brand-sales",
    validate: (v) => (v && Array.isArray(v.rows) ? true : "brand-sales payload has no rows[]"),
    enabled: true,
  }),
  report({
    reportKey: "sales-movers", reportVersion: "sales-movers-v1", label: "Sales Movers", domain: "insight",
    windowFor: ({ asOf }) => ({ to: asOf }),
    adapter: "sales-movers",
    validate: (v) => (v ? true : "sales-movers payload empty"),
    retentionDays: 14,
    // Live validation found some accounts need longer than one 60-second
    // function for this multi-export build. Keep it declared but disabled until
    // the adapter persists sub-export checkpoints; repeated whole-report retries
    // would waste DataDoe exports.
    enabled: false,
  }),

  // --- Declared, follow-up (enabled:false). Their adapters/builder extractions
  // are the next Phase-1 step; reportVersion for the legacy 7 is verbatim from
  // api/datadoe.js legacySharedDescriptor. Insight reportVersions must be
  // reconfirmed against the exported *_VERSION constant when enabling. ---
  report({ reportKey: "fba-plan", reportVersion: "fba-plan-shared-v1", label: "FBA Shipment Plan",
    windowFor: ({ asOf }) => ({ to: asOf }), adapter: "fba-plan",
    validate: (v) => (v && Array.isArray(v.rows) ? true : "fba-plan payload has no rows[]"), enabled: false }),
  report({ reportKey: "daily-reporting", reportVersion: "daily-reporting-shared-v1", label: "Daily Reporting",
    windowFor: ({ asOf }) => ({ from: addDaysStr(monthStartStr(asOf), -150), to: asOf, brand: "ALL" }), adapter: "daily-reporting", enabled: false }),
  report({ reportKey: "reconciliation", reportVersion: "reconciliation-shared-v1", label: "Reconciliation",
    windowFor: ({ asOf }) => ({ from: addDaysStr(monthStartStr(asOf), -180), to: asOf }), adapter: "reconciliation", retentionDays: 60, enabled: false }),
  report({ reportKey: "sku-pl", reportVersion: "sku-pl-shared-v1", label: "SKU P&L Analyzer",
    windowFor: ({ asOf }) => ({ from: addDaysStr(monthStartStr(asOf), -180), to: asOf }), adapter: "sku-pl", retentionDays: 60, enabled: false }),
  report({ reportKey: "keyword-rank", reportVersion: "keyword-rank-shared-v1", label: "Keyword Rank",
    windowFor: ({ asOf }) => ({ to: asOf }), adapter: "keyword-rank", enabled: false }),
  report({ reportKey: "content-changes", reportVersion: "content-changes-shared-v1", label: "Content Change Alerts",
    windowFor: ({ asOf }) => ({ asOf }), adapter: "content-changes", enabled: false }),
  report({ reportKey: "listing-health", reportVersion: "listing-health-v1", label: "Listing Health", domain: "insight",
    windowFor: ({ asOf }) => ({ to: asOf }), adapter: "listing-health", retentionDays: 14, enabled: false }),
  report({ reportKey: "buy-box-loss", reportVersion: "buy-box-loss-v1", label: "Buy Box Loss", domain: "insight",
    windowFor: ({ asOf }) => ({ to: asOf }), adapter: "buy-box-loss", retentionDays: 14, enabled: false }),
  report({ reportKey: "returns-leakage", reportVersion: "returns-leakage-v2", label: "Returns & Refund Leakage", domain: "insight",
    windowFor: ({ asOf }) => ({ to: asOf }), adapter: "returns-leakage", retentionDays: 14, enabled: false }),
  report({ reportKey: "ppc-performance", reportVersion: "ppc-performance-v1", label: "PPC Performance", domain: "insight",
    windowFor: ({ asOf }) => ({ to: asOf }), adapter: "ppc-performance", retentionDays: 14, enabled: false }),
  report({ reportKey: "listing-optimizer", reportVersion: "listing-optimizer-v1", label: "Listing & Search Optimizer", domain: "insight",
    windowFor: ({ asOf }) => ({ to: asOf }), adapter: "listing-optimizer", retentionDays: 14, enabled: false }),

  // NOT scheduled, on purpose: brand-view / brand-view-portfolio / brand-directory
  // and the legacy 'sales' rollup are cache-only aggregators that read already-saved
  // Supabase snapshots and never call DataDoe, so they have no source to sync.
];

/* ------------------------------------------------------------ selectors */

export function entriesForBucket(bucket) {
  return SYNC_REGISTRY.filter(
    (e) => e.enabled && (e.scheduleBucket === "both" || e.scheduleBucket === bucket)
  );
}

/**
 * Order work so ads sources run before reports (ads history seeds report/insight
 * ad metrics), then honour explicit dependencies with a stable topological sort.
 */
export function orderedWork(entries) {
  const byKey = new Map(entries.map((e) => [e.reportKey, e]));
  const rank = (e) => (e.domain === "ads" ? 0 : 1);
  const sorted = [...entries].sort((a, b) => rank(a) - rank(b));
  const out = [];
  const seen = new Set();
  const visit = (e) => {
    if (!e || seen.has(e.reportKey)) return;
    seen.add(e.reportKey);
    for (const dep of e.dependencies || []) if (byKey.has(dep)) visit(byKey.get(dep));
    out.push(e);
  };
  for (const e of sorted) visit(e);
  return out;
}

export function registryReportKeys() {
  return SYNC_REGISTRY.map((e) => e.reportKey);
}
