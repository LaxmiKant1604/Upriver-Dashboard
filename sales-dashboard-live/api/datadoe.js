// api/datadoe.js
//
// Serverless function that talks to DataDoe on the server side, so the
// DATADOE_API_KEY never reaches the browser. Deployed automatically by
// Vercel as /api/datadoe because it lives in the /api folder.
//
// IMPORTANT — please read:
// The endpoint paths below (ENDPOINTS) are inferred from DataDoe's MCP tool
// names (sellers_and_vendors_list, exports_create, exports_get,
// exports_raw_download), since DataDoe's docs confirm the REST API and MCP
// server expose the same underlying data. If DataDoe's actual REST paths
// turn out to differ, THIS is the only place that needs to change.
//
// To verify before relying on it, run this once with your real key
// (replace YOUR_KEY, never share the output containing your key):
//
//   curl -H "Authorization: Bearer YOUR_KEY" https://api.datadoe.com/api/v1/sellers-and-vendors
//
// If that doesn't return a list of your Amazon accounts, check
// https://api.datadoe.com/api/v1/docs for the correct path and let me know
// what you find — it's a one-line fix here.

import {
  DashboardAccessError,
  assertAccountAccess,
  assertAdmin,
  getAdsDailySourceRows,
  casUpdateReportSnapshotByRev,
  claimRefreshLock,
  deleteReportSnapshotByKey,
  getAsinAdsDailyRows,
  getDashboardAccess,
  getDailyAdsCoverage,
  getLatestReportSnapshot,
  getLatestReportSnapshotHydrated,
  getLatestReportSnapshotMeta,
  getReportSnapshot,
  getReportSnapshotsOlderThan,
  getSourceCoverageWindows,
  getSourceOliHistoryRows,
  getSourceSnapshot,
  getSourceSnapshotPayload,
  insertReportSnapshotIfAbsent,
  isSafeSnapshotRev,
  isSupabaseConfigured,
  publishSnapshotUpdate,
  releaseRefreshLock,
  saveReportSnapshot,
} from "../lib/server/supabase.js";
// Shared DataDoe transport. Extracted so every report — the seven original ones
// and the six insight reports — shares one 2-req/sec rate limiter, one export
// poller, and one row-cap policy.
import {
  DATADOE_BASE as BASE,
  ENDPOINTS,
  MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT,
  addDaysStr,
  authHeaders,
  createExport,
  daysInMonthUTC,
  ddFetch,
  downloadExport,
  fetchAccounts as fetchAccountsRaw,
  fetchExportRows as fetchExportRowsRaw,
  isDataDoeDeadlineError,
  isDataDoePollPendingError,
  isDateStr,
  isFullCalendarMonthWindow,
  num,
  pad2s,
  pollExport,
  splitDateRangeByMonth,
  canonicalOliSlices,
  withDataDoeDeadline,
} from "../lib/server/datadoe.js";
import {
  connectionForApiKey,
  decorateDataDoeAccount,
  getDataDoeConnections,
  mergeDiscoveredDataDoeAccounts,
  resolveDataDoeAccountIds,
  scopeDataDoeRows,
} from "../lib/server/datadoe-connections.js";
// Typed manual-continuation signals for the route's error mapping: retryable:true is allowed
// only when a durable continuation exists (see classifyDataDoeRouteError below).
import {
  MANUAL_CONTINUATION_IN_PROGRESS,
  isManualSourceContinuationError,
} from "../lib/server/manual-source-continuation.js";
import { beginSharedRefresh, paramsHashFor, serveSharedReport, wantsRefresh } from "../lib/server/report-store.js";
import { buildSalesMovers, SALES_MOVERS_REPORT_KEY, SALES_MOVERS_VERSION } from "../lib/server/reports/sales-movers.js";
import { buildListingHealth, LISTING_HEALTH_REPORT_KEY, LISTING_HEALTH_VERSION } from "../lib/server/reports/listing-health.js";
import { buildBuyBoxLoss, BUY_BOX_REPORT_KEY, BUY_BOX_VERSION } from "../lib/server/reports/buy-box.js";
import { buildReturnsLeakage, RETURNS_REPORT_KEY, RETURNS_VERSION } from "../lib/server/reports/returns.js";
import { buildPpcPerformance, PPC_REPORT_KEY, PPC_VERSION } from "../lib/server/reports/ppc.js";
import { buildListingOptimizer, OPTIMIZER_REPORT_KEY, OPTIMIZER_VERSION } from "../lib/server/reports/listing-optimizer.js";
// Account-scoped Brand View (Account -> Brand -> Brand Reports). Entirely
// separate from the older portfolio `brand-portfolio` action above: different
// report keys, different snapshot scope, different builders.
import {
  BRAND_VIEW_BRANDS_REPORT_KEY,
  BRAND_VIEW_BRANDS_VERSION,
  BRAND_VIEW_PORTFOLIO_REPORT_KEY,
  BRAND_VIEW_PORTFOLIO_VERSION,
  BRAND_VIEW_REPORT_KEY,
  BRAND_VIEW_VERSION,
  BRAND_INVENTORY_SNAPSHOT_KEY,
  BRAND_INVENTORY_REPORT_VERSION,
  brandViewPortfolioScopeId,
  brandViewScopeId,
  buildBrandViewBrandDirectory,
  buildBrandViewPortfolioSnapshot,
  buildBrandViewSnapshot,
  buildBrandInventorySnapshot,
} from "../lib/server/reports/brand-view.js";
import {
  selectorBrandsForAccount, buildBrandAccountMembership, brandKey, brandDisplay,
  serialiseBrandAccountMembership, membershipFingerprint,
} from "../lib/server/reports/brand-membership.js";
import { aggregateAsinAdsDailyRows } from "../lib/server/reports/asin-ads-aggregation.js";
import { rederiveDailyV2 } from "../lib/server/reports/daily-durable-rederive.js";
import { organizationFingerprint } from "../lib/server/source-identity.js";
import { FX_DISPLAY_CURRENCIES, getFxRates } from "../lib/server/fx.js";

// Keep the rest of this legacy route's report builders connection-agnostic.
// They still receive a normal API key and raw DataDoe seller IDs, while this
// wrapper returns the stable public account ID for secondary-connection rows.
async function fetchExportRows(apiKey, ...args) {
  const rows = await fetchExportRowsRaw(apiKey, ...args);
  return scopeDataDoeRows(connectionForApiKey(apiKey), rows);
}

async function fetchAccounts(apiKey) {
  const connection = connectionForApiKey(apiKey);
  const accounts = await fetchAccountsRaw(apiKey);
  return accounts.map((account) => decorateDataDoeAccount(connection, account));
}

const ACCOUNT_SCOPED_ACTIONS = new Set([
  "sales", "brand-sales", "daily", "reconciliation", "sku-pl",
  "keyword-rank", "content-changes", "fba-plan", "brand-inventory",
  // Account-scoped Brand View. Both actions take exactly one account, are
  // authorised against it, and read only that account's saved snapshots.
  "brand-view-brands", "brand-view",
  // Insight reports. Each is single-account and served from the shared
  // Supabase snapshot unless an explicit refresh is requested.
  // The Priority Feed has no action of its own: it combines the six snapshots
  // in the browser, so there is nothing extra to authorise here.
  "sales-movers", "listing-health", "buy-box-loss",
  "returns-leakage", "ppc-performance", "listing-optimizer",
]);

// Every insight report is strictly one selected account: the shared snapshot,
// the refresh lock, and the permission check are all keyed by a single account.
function singleAccountId(req, res, label) {
  const ids = String(req.query.ids || "").split(",").filter(Boolean);
  if (ids.length !== 1) {
    res.status(400).json({ error: `${label} requires exactly one selected account.` });
    return null;
  }
  return ids;
}

function reportAsOf(req, res) {
  const to = String(req.query.to || "");
  if (!isDateStr(to)) {
    res.status(400).json({ error: "Invalid or missing `to` date. Use YYYY-MM-DD." });
    return null;
  }
  return to;
}

// Source table for daily sales/units per account. 401ffcd7e5 ("Sales &
// Traffic by ASIN & Date") is the user-confirmed correct sales report.
// (Previously used b24cd69c06 "Profit by Date".) DataDoe aggregates each
// export by the non-metric columns selected, so requesting only date +
// seller_or_vendor_id returns one row per account per day.
// Dashboard source: fast daily per-account rollup ("Profit by Date",
// ~1 row/account/day, includes order counts). Used by action=sales for the
// multi-account dashboard, where per-ASIN volume would be millions of rows.
const DASHBOARD_SOURCE_ID = "b24cd69c06";
const DASHBOARD_COLUMNS = [
  "date",
  "seller_or_vendor_id",
  "seller_or_vendor_name",
  "marketplace_country_code",
  "currency",
  "total_sales",
  "total_units_sold",
  "total_orders",
];

// Main dashboard sales source. Order Line Items is the Seller Central order
// report equivalent: `item_price_value` is the source-of-truth ordered item
// value, including pending orders. It intentionally replaces Profit by SKU &
// Date, which includes shipped orders only and therefore cannot reconcile to
// Seller Central's Order Report total.
const ORDER_LINE_ITEMS_SOURCE_ID = "89b27535d27c2a94db5ae39af4717f542624ff4df7802fd633e16c78674a1778";
const ORDER_SALES_COLUMNS = [
  "date",
  "seller_or_vendor_id",
  "seller_or_vendor_name",
  "marketplace_country_code",
  "item_price_currency",
  "child_asin",
];
const ORDER_SALES_AGGREGATIONS = [
  { column: "item_price_value", aggregation: "sum", alias: "total_sales_sum" },
  { column: "quantity", aggregation: "sum", alias: "total_units_sold_sum" },
];
const ORDER_SALES_GROUP_BY = [
  "date",
  "seller_or_vendor_id",
  "seller_or_vendor_name",
  "marketplace_country_code",
  "item_price_currency",
  "child_asin",
];

// Product Catalog by ASIN. This is the authoritative ASIN-to-brand mapping
// used to populate the brand selector, including brands with no sales in the
// selected reporting window.
//
// The live primary DataDoe organization's Export Source ID for this dataset is the
// SHORT id "68d2de238e". The former long id
// (68d2de238e8d1a47bc56a981a99d54558507b0bafb1e09f1b3e95fb7750a17a8) is obsolete and
// returns DataDoe "404 Source not found", so it is never used for a live request; it
// remains registered ONLY as a legacy alias in source-contracts.js so cached exports
// and request_hash identity (derived from the canonical contract key) stay stable.
const PRODUCT_CATALOG_SOURCE_ID = "68d2de238e";
const PRODUCT_CATALOG_COLUMNS = [
  "child_asin",
  "parent_asin",
  "product_name",
  "product_brand",
];

// Each of these snapshots already preserves catalog brand names at an
// account-level grain. They let Brand View rebuild its directory from
// Supabase when DataDoe Product Catalog exports are unavailable or out of
// credits, without guessing a brand's country from portfolio-wide data.
const BRAND_DIRECTORY_SNAPSHOT_KEYS = [
  // This compact per-account catalog snapshot is populated only by the
  // explicit Brand View directory sync. It is first because it includes
  // catalog brands even when an item has not sold in the report window.
  "brand-catalog",
  "brand-sales",
  "fba-plan",
  "sku-pl",
  SALES_MOVERS_REPORT_KEY,
  LISTING_HEALTH_REPORT_KEY,
  BUY_BOX_REPORT_KEY,
  RETURNS_REPORT_KEY,
  PPC_REPORT_KEY,
  OPTIMIZER_REPORT_KEY,
  "content-changes",
];

const BRAND_CATALOG_REPORT_KEY = "brand-catalog";
const BRAND_CATALOG_REPORT_VERSION = "brand-catalog-shared-v1";
// The live brand-sales snapshot key -- the authoritative portfolio-MEMBERSHIP evidence (figures already read it).
const BRAND_SALES_REPORT_KEY = "brand-sales";
// EXACTLY ONE Product Catalog export per invocation. A single export can poll for
// close to 45s (pollExport: 9 x 5s) plus create + download, which already approaches
// Vercel's 60-second limit; running a second export in the same request could exceed
// it. One-per-invocation is the strict, provable budget guard -- a slow export can
// never consume the next cursor item because the next item is not touched this request.
// The browser continues the remaining accounts one at a time. DataDoe exports are NEVER
// parallelised.
export const BRAND_CATALOG_BATCH_SIZE = 1;

// Admin-safe catalog outcome codes. NEVER surface a raw DataDoe response body,
// source id, URL, JSON, status object, key or token to the browser -- only one of
// these typed codes.
export const CATALOG_SOURCE_UNAVAILABLE = "PRODUCT_CATALOG_SOURCE_UNAVAILABLE";
export const CATALOG_EMPTY = "PRODUCT_CATALOG_EMPTY";
export const CATALOG_TRUNCATED = "PRODUCT_CATALOG_TRUNCATED";
export const CATALOG_FETCH_FAILED = "PRODUCT_CATALOG_FETCH_FAILED";
// An attempt that was atomically claimed (or is mid-flight / whose outcome write
// failed) but has no confirmed terminal outcome yet. It is admin-safe and NEVER
// auto-retried: it waits for a NEW explicit action id. It is not produced by
// classifyCatalogError (only real transport errors are), so it never masquerades
// as a source failure.
export const CATALOG_ATTEMPT_PENDING = "PRODUCT_CATALOG_ATTEMPT_PENDING";
export const SAFE_CATALOG_CODES = new Set([
  CATALOG_SOURCE_UNAVAILABLE, CATALOG_EMPTY, CATALOG_TRUNCATED, CATALOG_FETCH_FAILED, CATALOG_ATTEMPT_PENDING,
]);

// Durable, per-(action,account) attempt state, stored SEPARATELY from the
// brand-catalog LKG snapshot. Keeping it in its own report row is what lets a
// failed refresh preserve the successful LKG payload byte-for-byte (its
// source_refreshed_at never advances) AND lets two overlapping actions record
// their own cumulative failure summaries without clobbering each other, because
// the params hash below is scoped by BOTH accountId and actionId.
const BRAND_CATALOG_ATTEMPT_KEY = "brand-catalog-attempt";
const BRAND_CATALOG_ATTEMPT_VERSION = "brand-catalog-attempt-v1";
// The claim is held only across ONE export. A single export polls for ~45s max
// (pollExport 9x5s) plus create + download, so a lock comfortably longer than that
// but far shorter than any human retry window bounds a crashed invocation without
// wedging the account: after it expires, only a NEW explicit action re-claims,
// because the durable "attempting" marker written before create-export still blocks
// same-action replays.
const CATALOG_ATTEMPT_LOCK_SECONDS = 90;

// A safe token shape for the correlation id of ONE explicit action. Anything else
// (missing, PII, oversized, punctuation) is rejected -- never persisted or echoed.
export function validCatalogActionId(value) {
  const id = String(value == null ? "" : value);
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

function catalogAttemptHash(accountId, actionId) {
  return paramsHashFor(BRAND_CATALOG_ATTEMPT_VERSION, { accountId, actionId });
}

// ATOMIC claim BEFORE any DataDoe create-export. claim_report_refresh_lock is a
// database upsert-with-expiry: exactly one of two concurrent same-(action,account)
// requests wins. The loser creates ZERO exports. Keyed by the attempt hash so it is
// scoped to one action + one account and never collides with a report refresh lock.
async function defaultClaimCatalogAttempt(accountId, actionId) {
  return claimRefreshLock({
    reportKey: BRAND_CATALOG_ATTEMPT_KEY,
    accountId,
    paramsHash: catalogAttemptHash(accountId, actionId),
    lockSeconds: CATALOG_ATTEMPT_LOCK_SECONDS,
  });
}

async function defaultReleaseCatalogAttempt(accountId, actionId) {
  return releaseRefreshLock({
    reportKey: BRAND_CATALOG_ATTEMPT_KEY,
    accountId,
    paramsHash: catalogAttemptHash(accountId, actionId),
  });
}

// Read THIS action's durable attempt row for one account (exact params hash, not the
// latest-by-account read) so overlapping actions never read each other's state.
async function defaultGetCatalogAttemptState(accountId, actionId) {
  const snapshot = await getReportSnapshot({
    reportKey: BRAND_CATALOG_ATTEMPT_KEY,
    accountId,
    paramsHash: catalogAttemptHash(accountId, actionId),
  });
  return snapshot?.payload || null;
}

// Persist THIS action's durable attempt state. Never carries a raw DataDoe body --
// only a typed safe code. This row, not the LKG snapshot, is where a failed refresh
// is recorded.
async function defaultSaveCatalogAttemptState(accountId, actionId, state) {
  const paramsHash = catalogAttemptHash(accountId, actionId);
  const payload = {
    actionId,
    accountId: String(accountId),
    status: state.status,
    code: state.code || null,
    preservedLkg: Boolean(state.preservedLkg),
    updatedAt: new Date().toISOString(),
  };
  await saveReportSnapshot({
    reportKey: BRAND_CATALOG_ATTEMPT_KEY,
    accountId,
    paramsHash,
    params: { reportVersion: BRAND_CATALOG_ATTEMPT_VERSION, accountId, actionId },
    payload,
    payloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
    sourceRefreshedAt: new Date().toISOString(),
  });
}

// Durable, SERVER-OWNED action manifest. One row per explicit refresh action, keyed by
// the action id. It -- not the browser cursor -- owns the work queue: the authoritative
// list of primary accounts still to attempt, the discovered scope, the requesting admin,
// the status, and an optimistic-concurrency version `rev`. A continuation loads this manifest
// and may only pass its cursor as a consistency check; it can never define server work or
// create an action implicitly. Stored in report_snapshots (no migration) under a fixed account
// id, differentiated by the action id in the params hash. Retention is STATUS-AWARE (see
// below), so an in-progress action is never removed merely because it is old.
//
// CONCURRENCY: EVERY manifest transition (both the orchestrator's and retention's expiry) is a
// compare-and-swap on `rev` (see defaultSaveCatalogActionManifest). A write succeeds only if the
// stored row is still at the rev the writer loaded; otherwise it loses the race and the caller
// re-decides. This makes the two interleavings safe: a continuation that commits between
// retention's re-read and its expiry write causes retention's CAS to miss (retention does not
// overwrite it); and if retention expires first, a stale continuation's CAS misses (it cannot
// restore in-progress/complete over the expired row -> it 409s). This replaces the earlier
// updatedAt read-then-write, which was not atomic.
const BRAND_CATALOG_ACTION_KEY = "brand-catalog-action";
const BRAND_CATALOG_ACTION_VERSION = "brand-catalog-action-v1";
const BRAND_CATALOG_ACTION_ACCOUNT = "__brand-catalog-action__";
// Terminal actions older than this window are pruned (manifest + their attempt rows). An
// in-progress action is NEVER pruned merely because it is old.
const BRAND_CATALOG_ACTION_RETENTION_DAYS = 7;
// An in-progress action is considered ABANDONED (and rejected/expired) only after this far
// longer window, well beyond any real refresh (which completes in seconds). A continuation
// arriving after it transitions the manifest to the terminal "expired" state and is rejected
// with a 409; retention then prunes the expired action like any other terminal one.
const BRAND_CATALOG_ACTION_ABANDON_DAYS = 30;
// Actions in these states are terminal: safe to prune once older than the retention window,
// and (for anything other than "complete") a continuation is rejected with a 409.
const TERMINAL_CATALOG_ACTION_STATES = new Set(["complete", "operational-failure", "expired"]);

// Admin-safe codes for the action orchestrator. A conflict is any request that does not
// match the server-owned manifest (unknown/changed action, wrong admin, changed scope,
// tampered cursor). An operational failure is a durable-state persistence failure that
// stops the action without reporting completion. Neither ever carries a raw body.
export const BRAND_DIRECTORY_ACTION_CONFLICT = "BRAND_DIRECTORY_ACTION_CONFLICT";
export const BRAND_DIRECTORY_ACTION_UNAVAILABLE = "BRAND_DIRECTORY_ACTION_UNAVAILABLE";

function catalogActionHash(actionId) {
  return paramsHashFor(BRAND_CATALOG_ACTION_VERSION, { actionId });
}

// The manifest optimistic-version invariant is the SHARED isSafeSnapshotRev (positive safe
// integer whose increment is safe). A loaded manifest whose rev violates it is corrupt/legacy
// and MUST fail closed -- never treated as new (which would bypass CAS and could clobber an
// advanced row), and never used to CAS (a malformed rev could concatenate or overflow).

// Deterministic hash of the discovered authorized PRIMARY scope. A continuation whose
// authorized scope no longer hashes to the manifest's value (injected/removed account,
// changed permissions) is rejected before any DataDoe call.
function defaultCatalogScopeHash(accountIds) {
  const ids = [...new Set((accountIds || []).map((id) => String(id || "").trim()).filter(Boolean))].sort();
  return paramsHashFor("brand-catalog-action-scope-v1", { ids: ids.join(",") });
}

async function defaultLoadCatalogActionManifest(actionId) {
  const snapshot = await getReportSnapshot({
    reportKey: BRAND_CATALOG_ACTION_KEY,
    accountId: BRAND_CATALOG_ACTION_ACCOUNT,
    paramsHash: catalogActionHash(actionId),
  });
  return snapshot?.payload || null;
}

// Persist a manifest transition. Contract used by BOTH the orchestrator and retention:
//   - manifest.rev == null  -> CREATE (first write): atomic INSERT-IF-ABSENT at rev 1; returns 1
//     when inserted, or `false` when a row already exists (create conflict -- never overwritten).
//   - manifest.rev is set    -> CAS UPDATE: succeeds only if the stored row is still at that
//     rev; returns the NEW rev on success, or `false` when the CAS lost (a concurrent write
//     moved the row on). A transport failure THROWS.
async function defaultSaveCatalogActionManifest(actionId, manifest) {
  const paramsHash = catalogActionHash(actionId);
  const sourceRefreshedAt = manifest.updatedAt || new Date().toISOString();
  if (manifest.rev == null) {
    // CREATE via atomic INSERT-IF-ABSENT (never merge/overwrite). A delayed second creator that
    // also loaded "missing" LOSES here instead of clobbering an already-advanced/stopped row.
    const payload = { ...manifest, rev: 1 };
    const inserted = await insertReportSnapshotIfAbsent({
      reportKey: BRAND_CATALOG_ACTION_KEY,
      accountId: BRAND_CATALOG_ACTION_ACCOUNT,
      paramsHash,
      params: { reportVersion: BRAND_CATALOG_ACTION_VERSION, actionId },
      payload,
      payloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
      sourceRefreshedAt,
    });
    return inserted ? 1 : false; // false => a row already exists (create conflict)
  }
  // EXISTING-ROW CAS: a non-null rev MUST satisfy the shared invariant. Fail closed (throw)
  // BEFORE any write so a malformed rev can never CAS (e.g. a string "1" concatenating to "11").
  if (!isSafeSnapshotRev(manifest.rev)) {
    throw new Error("defaultSaveCatalogActionManifest: existing manifest rev is not a positive safe integer.");
  }
  const expectedRev = manifest.rev;
  const payload = { ...manifest, rev: expectedRev + 1 };
  const won = await casUpdateReportSnapshotByRev({
    reportKey: BRAND_CATALOG_ACTION_KEY,
    accountId: BRAND_CATALOG_ACTION_ACCOUNT,
    paramsHash,
    expectedRev,
    payload,
    sourceRefreshedAt,
  });
  return won ? expectedRev + 1 : false;
}

async function defaultListOldCatalogActions({ cutoffIso }) {
  const rows = await getReportSnapshotsOlderThan({ reportKey: BRAND_CATALOG_ACTION_KEY, cutoffIso });
  return (rows || []).map((row) => {
    const payload = row.payload || {};
    const accountIds = [
      ...(Array.isArray(payload.primaryAccountIds) ? payload.primaryAccountIds : []),
      ...(Array.isArray(payload.remaining) ? payload.remaining : []),
      ...(payload.current ? [payload.current] : []),
    ];
    return {
      actionId: payload.actionId || row.params?.actionId || null,
      status: payload.status || null,
      // The PAYLOAD updatedAt is the field we control on every transition; use it (not the
      // storage column) for the race guard so a re-read compares like-for-like.
      updatedAt: payload.updatedAt || row.updated_at || null,
      accountIds: [...new Set(accountIds.map(String))],
    };
  });
}

// STATUS-AWARE, BEST-EFFORT retention with ACCURATE deletion accounting.
//
// TERMINAL action (complete / operational-failure / expired), old enough:
//   - delete EVERY attempt row first, positively confirming each deletion;
//   - delete the manifest ONLY after all attempt deletions succeeded (attempts-then-manifest);
//   - if ANY attempt deletion fails: leave the manifest AND the remaining attempts, stop this
//     action, and let the next pass retry. A missing row is an idempotent success.
// IN-PROGRESS action, past its expiresAt (abandoned):
//   - NEVER directly deleted. Re-read its exact manifest, verify it is STILL in-progress and
//     still expired, then durably transition it to the terminal "expired" state via a CAS on the
//     rev it just read. If a continuation commits between the re-read and the CAS, the CAS LOSES
//     and retention does not overwrite it. Its attempts + manifest are pruned only on a LATER
//     pass (once the persisted "expired" state is observed). If the expiry CAS loses or the write
//     fails, the in-progress manifest and all its attempts are preserved for retry.
// brand-catalog LKG and account-directory rows use different report keys and are NEVER touched.
// Must never fail a refresh.
export async function pruneBrandCatalogActionRecords(deps = {}) {
  const listOldActions = deps.listOldActions || defaultListOldCatalogActions;
  const loadManifest = deps.loadManifest || defaultLoadCatalogActionManifest;
  const saveManifest = deps.saveManifest || defaultSaveCatalogActionManifest;
  const deleteManifest = deps.deleteManifest || ((actionId) => deleteReportSnapshotByKey({ reportKey: BRAND_CATALOG_ACTION_KEY, accountId: BRAND_CATALOG_ACTION_ACCOUNT, paramsHash: catalogActionHash(actionId) }));
  const deleteAttempt = deps.deleteAttempt || ((accountId, actionId) => deleteReportSnapshotByKey({ reportKey: BRAND_CATALOG_ATTEMPT_KEY, accountId, paramsHash: catalogAttemptHash(accountId, actionId) }));
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs() : Date.now();
  const nowIso = deps.now || (() => new Date().toISOString());
  const cutoffIso = new Date(nowMs - BRAND_CATALOG_ACTION_RETENTION_DAYS * 86_400_000).toISOString();

  // A deletion/transition is CONFIRMED only when it resolves truthy (an explicit `false` or a
  // throw both count as failure). This is the best-effort boundary; the primitive itself reports
  // accurately and never swallows its own failure.
  const confirmed = async (fn) => { try { return (await fn()) !== false; } catch { return false; } };

  let oldActions;
  try { oldActions = await listOldActions({ cutoffIso }); } catch { return; } // best-effort
  for (const action of oldActions || []) {
    if (!action.actionId) continue;

    if (TERMINAL_CATALOG_ACTION_STATES.has(action.status)) {
      // Attempts first, each positively confirmed; the manifest is deleted LAST and only if all
      // attempt deletions succeeded, so a failed attempt delete can never orphan its rows.
      let allAttemptsDeleted = true;
      for (const accountId of action.accountIds || []) {
        if (!(await confirmed(() => deleteAttempt(accountId, action.actionId)))) { allAttemptsDeleted = false; break; }
      }
      if (!allAttemptsDeleted) continue; // keep the manifest; the next pass retries idempotently
      await confirmed(() => deleteManifest(action.actionId)); // if this fails, the next pass retries
      continue;
    }

    // An OLD in-progress action is NEVER directly deleted. Past its expiresAt it is first durably
    // transitioned to terminal "expired"; a later pass prunes it as terminal.
    if (action.status !== "in-progress") continue;
    let current;
    try { current = await loadManifest(action.actionId); } catch { continue; } // best-effort
    // Re-read guard: it must still be in-progress and still expired. The ATOMIC guard against a
    // racing continuation is the CAS below (on current.rev) -- not this read-then-check -- so we
    // do NOT rely on comparing updatedAt.
    if (!current || current.status !== "in-progress") continue;
    if (!(current.expiresAt && Date.parse(current.expiresAt) < nowMs)) continue;
    // The re-read manifest MUST satisfy the shared revision invariant before any save. A
    // missing/malformed rev fails closed: SKIP (zero saves, zero deletes) and preserve the
    // manifest + all its attempts. This also guarantees retention never passes a null rev to
    // saveManifest -- which would be misinterpreted as first-create.
    if (!isSafeSnapshotRev(current.rev)) continue;
    // Durably transition to "expired" via a CAS on the rev just read. If a continuation committed
    // between the re-read and here, the CAS LOSES (`confirmed` is false) and retention does NOT
    // overwrite it; the in-progress manifest and all its attempts are preserved for a later pass.
    await confirmed(() => saveManifest(action.actionId, { ...current, status: "expired", updatedAt: nowIso() }));
  }
}

// Map a fetch/transport error to a typed code WITHOUT persisting or returning its
// raw message. A 404 "Source not found" is a source-access/config issue (the obsolete
// long id, or an unenabled primary source); the row cap is a truncation; anything else
// is a generic fetch failure.
export function classifyCatalogError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/row cap/i.test(message)) return CATALOG_TRUNCATED;
  if (/\(404\)/.test(message) || /source not found/i.test(message)) return CATALOG_SOURCE_UNAVAILABLE;
  return CATALOG_FETCH_FAILED;
}

// PURE: split the work cursor into the accounts attempted THIS request and the typed
// continuation for the browser. Each account appears in exactly one batch across the
// explicit action, so it is attempted at most once and the loop always terminates.
export function nextCatalogBatch(cursorIds, batchSize = BRAND_CATALOG_BATCH_SIZE) {
  const cursor = [...new Set((cursorIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  return { batch: cursor.slice(0, batchSize), remainingAccountIds: cursor.slice(batchSize) };
}

// PRIMARY-ONLY: a dormant `dd-secondary:`-prefixed record is skipped read-only. Only a
// real primary account id (no prefix) is eligible for a live catalog export; a legacy
// secondary id is never stripped and routed through the primary key.
function isPrimaryCatalogAccount(accountId) {
  const id = String(accountId || "").trim();
  return Boolean(id) && !id.startsWith("dd-secondary:");
}

// PURE: which accounts a fresh explicit action should attempt once, given the accounts
// just DISCOVERED from the primary DataDoe organization and the shared-snapshot directory
// state. Discovery is the sole source of the active set -- a newly added primary account
// needs no code change, config, or manual mapping to appear here:
//   - a newly discovered primary account (no snapshot yet -> pending) is scheduled;
//   - a previously-unavailable primary account is scheduled (retry), never starved;
//   - an already-complete account is NOT in the pending/unavailable candidate set, so it
//     is never attempted twice;
//   - a REMOVED account (absent from the current discovery) is never scheduled, even if a
//     stale pending/unavailable marker still names it -- its last-known-good snapshot is
//     left untouched;
//   - a dormant `dd-secondary:` record is never treated as a primary catalog account.
export function catalogSyncEligibleAccounts(discoveredAccountIds, directory = {}) {
  const discoveredPrimary = new Set(
    [...new Set((discoveredAccountIds || []).map((id) => String(id || "").trim()).filter(Boolean))]
      .filter(isPrimaryCatalogAccount)
  );
  const unavailable = directory.catalogUnavailable instanceof Map
    ? [...directory.catalogUnavailable.keys()]
    : (directory.catalogUnavailable || []);
  const candidate = new Set([...(directory.catalogPendingAccountIds || []), ...unavailable].map((id) => String(id)));
  return [...candidate].filter((id) => discoveredPrimary.has(id)).sort();
}

// A catalog counts as brand coverage ONLY when it contains at least one USABLE mapping:
// a non-empty child_asin joined to a real, non-empty product_brand. "Unassigned" is the
// no-brand placeholder and is never a real brand. Returns the sorted distinct real
// brands from usable rows; an empty result means the catalog is unusable
// (`PRODUCT_CATALOG_EMPTY`), e.g. a row like {child_asin:"", product_brand:"Bebi Born"}.
export function usableCatalogBrands(rows) {
  const brands = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const asin = String(row?.child_asin || "").trim();
    const brand = String(row?.product_brand || "").trim();
    if (asin && brand && brand !== "Unassigned") brands.add(brand);
  }
  return [...brands].sort((a, b) => a.localeCompare(b));
}

const BRAND_PORTFOLIO_REPORT_KEY = "brand-portfolio";
const BRAND_PORTFOLIO_VERSION = "brand-portfolio-shared-v3";
const BRAND_ADS_SOURCE_KEY = "asin-performance-v1";

// Brand View is a portfolio report, but it must be as quick and cheap as any
// account report once users have refreshed their source snapshots.  It reads
// the shared account snapshots and the scheduled ASIN-level Ads history only;
// it never starts a new DataDoe export itself.  This is what lets one saved
// portfolio snapshot be reused by every authorised user.
async function buildBrandPortfolioSnapshot({ brand, accountIds, asOf }) {
  const rows = [];
  const ads = [];
  const inventory = [];
  const unavailable = [];

  for (const accountId of accountIds) {
    const salesSnapshot = await getLatestReportSnapshot({ reportKey: "brand-sales", accountId });
    const salesPayload = salesSnapshot?.payload;
    const sourceRows = salesPayload?.rows || [];
    if (!sourceRows.length) {
      unavailable.push({ accountId, reason: "No saved account sales snapshot" });
      continue;
    }

    const asinBrand = new Map();
    for (const row of sourceRows) {
      const rowBrand = String(row.product_brand || "").trim();
      const asin = String(row.child_asin || "").trim();
      if (asin && rowBrand) asinBrand.set(asin, rowBrand);
      if (rowBrand !== brand) continue;
      rows.push({
        ...row,
        accountId,
        accountName: row.seller_or_vendor_name || null,
        accountCountry: row.marketplace_country_code || null,
        accountCurrency: row.currency || null,
      });
    }

    // Inventory is read from the latest saved FBA-plan snapshot.  Its ASIN
    // mapping is already joined to the product brand and its fields are live
    // FBA Health values, so no client-side inference is needed.
    const planSnapshot = await getLatestReportSnapshot({ reportKey: "fba-plan", accountId });
    const planPayload = planSnapshot?.payload;
    let fbaAvailable = 0;
    let fbaKnown = false;
    for (const row of planPayload?.rows || []) {
      if (String(row.brand || "").trim() !== brand) continue;
      if (row.fbaAvailable === null || row.fbaAvailable === undefined) continue;
      fbaKnown = true;
      fbaAvailable += num(row.fbaAvailable);
    }
    if (fbaKnown) {
      const sample = sourceRows.find((row) => String(row.product_brand || "").trim() === brand) || sourceRows[0];
      inventory.push({
        accountId,
        country: sample.marketplace_country_code || null,
        currency: sample.currency || null,
        fbaAvailable,
        snapshotDate: planPayload?.inventoryDate || null,
      });
    }

    // ASIN-level Ads history is maintained by the scheduled worker.  Joining
    // it to this account's saved ASIN->brand map avoids the old bug where all
    // account spend was displayed for one selected brand.
    try {
      const adRows = await getAdsDailySourceRows({
        accountId,
        sourceKeys: [BRAND_ADS_SOURCE_KEY],
        from: addDaysStr(asOf, -60),
        to: asOf,
        maxRows: 60000,
      });
      for (const row of adRows) {
        if (asinBrand.get(String(row.child_asin || "").trim()) !== brand) continue;
        ads.push({
          accountId,
          date: row.metric_date,
          country: row.marketplace_country_code || null,
          currency: row.currency || null,
          adSpend: num(row.metrics?.ad_spend),
        });
      }
    } catch (error) {
      unavailable.push({ accountId, reason: `Saved Ads history unavailable: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  return {
    brand,
    asOf,
    rows,
    ads,
    inventory,
    unavailable,
    sources: {
      sales: "Saved Brand Sales snapshots (Order Line Items + Product Catalog)",
      ads: "Saved Ad Performance by ASIN & Date history",
      inventory: "Saved FBA Shipment Plan snapshots (FBA Inventory Health)",
    },
  };
}

function snapshotBrandNames(payload) {
  const names = new Set((payload?.catalogBrands || []).map((brand) => String(brand || "").trim()).filter(Boolean));
  // Older Dashboard and SKU P&L snapshots predate catalogBrands on every
  // payload, but their row records still carry the joined brand. This keeps
  // the directory recoverable after a schema upgrade without any DataDoe call.
  (payload?.rows || []).forEach((row) => {
    const brand = row?.product_brand || row?.brand;
    if (String(brand || "").trim()) names.add(String(brand).trim());
  });
  return [...names];
}

async function sharedSnapshotBrandAccounts(accountIds, { actionId = null, getAttemptState = defaultGetCatalogAttemptState } = {}) {
  const selectorByKey = new Map();    // SELECTOR list (canonical key -> display): catalog(complete) UNION sales (+ fallbacks); never pins
  const perAccountSales = [];         // MEMBERSHIP evidence: [{accountId, salesBrands}] -> buildBrandAccountMembership (canonical-key based)
  const salesMeta = [];               // fingerprint parts: [{accountId, updatedAt, paramsHash}] over the latest brand-sales identity per account
  const coveredAccountIds = new Set();
  const catalogPendingAccountIds = new Set();
  const catalogUnavailable = new Map();
  // Accounts whose latest attempt under THIS action did not succeed -- whether their brand
  // map is a preserved last-known-good ("complete") or absent. Their typed code must appear
  // in the cumulative summary even after later continuations reread them, and it is read
  // from the SEPARATE per-(action,account) attempt row so overlapping actions never clobber
  // each other's summaries.
  const catalogActionFailures = new Map();
  const addSelector = (entries) => { for (const e of (entries || [])) if (e && e.key && !selectorByKey.has(e.key)) selectorByKey.set(e.key, e.display); };
  const finalise = () => ({
    membership: buildBrandAccountMembership(perAccountSales),
    selectorEntries: [...selectorByKey.entries()].map(([key, display]) => ({ key, display })),
    fingerprint: membershipFingerprint(salesMeta),
    coveredAccountIds, catalogPendingAccountIds, catalogUnavailable, catalogActionFailures,
  });
  if (!isSupabaseConfigured()) return finalise();

  // MEMBERSHIP follows the CURRENT sales evidence (latest validated brand-sales), so it matches the figures and
  // never drops a selling account (nor pins a catalog-only, zero-sale account). The complete catalog still
  // supplies the SELECTOR list (zero-sale brands), and other reports keep the selector recoverable while an
  // account waits for its one-time catalog sync -- but only brand-sales pins membership.
  await Promise.all(accountIds.map(async (accountId) => {
    const id = String(accountId);
    const catalogSnapshot = await getLatestReportSnapshotHydrated({ reportKey: BRAND_CATALOG_REPORT_KEY, accountId });
    const payload = catalogSnapshot?.payload;
    const catalogStatus = payload?.catalogSyncStatus;
    const catalogBrands = snapshotBrandNames(payload);
    // A non-successful attempt under THIS action is surfaced separately so it is never lost
    // across continuation batches. Read from the durable attempt row (scoped by action +
    // account); typed safe codes only, never a raw DataDoe body.
    if (actionId) {
      const attempt = await Promise.resolve(getAttemptState(id, actionId)).catch(() => null);
      if (attempt && attempt.status && attempt.status !== "complete") {
        const attemptCode = String(attempt.code || "");
        catalogActionFailures.set(id, SAFE_CATALOG_CODES.has(attemptCode)
          ? attemptCode
          : (attempt.status === "attempting" ? CATALOG_ATTEMPT_PENDING : CATALOG_SOURCE_UNAVAILABLE));
      }
    }

    // (1) MEMBERSHIP: the latest validated brand-sales snapshot ONLY, hydrated STORAGE-FIRST so a large out-of-line
    // payload never silently drops its account. An account is a member of a brand iff its current brand-sales
    // contains it (canonical-key matched). Its snapshot identity feeds the self-heal fingerprint.
    const salesSnapshot = await getLatestReportSnapshotHydrated({ reportKey: BRAND_SALES_REPORT_KEY, accountId });
    const salesBrands = snapshotBrandNames(salesSnapshot?.payload);
    perAccountSales.push({ accountId: id, salesBrands });
    if (salesSnapshot) salesMeta.push({ accountId: id, updatedAt: String(salesSnapshot.updated_at || salesSnapshot.source_refreshed_at || ""), paramsHash: String(salesSnapshot.params_hash || "") });

    // (2) SELECTOR list only: a complete catalog contributes its (zero-sale-inclusive) brands, unioned with
    // brand-sales. Selector brands NEVER pin membership.
    addSelector(selectorBrandsForAccount({ catalogStatus, catalogBrands, salesBrands }));

    if (catalogStatus === "complete") { coveredAccountIds.add(id); return; }
    if (catalogStatus === "unavailable") {
      // Only a typed, admin-safe code is carried forward. Any legacy raw `catalogSyncError` on an older snapshot
      // is IGNORED (never surfaced): unknown codes normalise to the generic source-unavailable code.
      const rawCode = String(payload?.catalogSyncCode || "");
      catalogUnavailable.set(id, SAFE_CATALOG_CODES.has(rawCode) ? rawCode : CATALOG_SOURCE_UNAVAILABLE);
    } else {
      catalogPendingAccountIds.add(id);
    }
    if (salesBrands.length) { coveredAccountIds.add(id); return; }

    // No complete catalog and no brand-sales: recover the SELECTOR list from other report snapshots (fba-plan,
    // sku-pl, ...). This never pins membership -- brand-sales is the only membership authority.
    for (const reportKey of BRAND_DIRECTORY_SNAPSHOT_KEYS.slice(2)) {
      const snapshot = await getLatestReportSnapshotHydrated({ reportKey, accountId });
      const brands = snapshotBrandNames(snapshot?.payload);
      if (brands.length) {
        addSelector(brands.map((b) => ({ key: brandKey(b), display: brandDisplay(b) })).filter((e) => e.key));
        coveredAccountIds.add(id);
        break;
      }
    }
  }));
  return finalise();
}

// The LIVE membership fingerprint from CHEAP metadata reads only (no payload hydration): the fingerprint of the
// latest brand-sales snapshot identity for each authorized account. The directory read compares it against the
// stored directory's saved fingerprint to decide whether to self-heal -- so an unchanged directory is served
// immediately and a changed one is rebuilt exactly once. ZERO DataDoe.
async function brandSalesFingerprint(accountIds) {
  if (!isSupabaseConfigured()) return "";
  const meta = await Promise.all((accountIds || []).map(async (accountId) => {
    const m = await getLatestReportSnapshotMeta({ reportKey: BRAND_SALES_REPORT_KEY, accountId }).catch(() => null);
    return { accountId: String(accountId), updatedAt: String(m?.updated_at || m?.source_refreshed_at || ""), paramsHash: String(m?.params_hash || "") };
  }));
  return membershipFingerprint(meta);
}

// Assemble the directory READ payload from a rebuilt membership map (+ the typed catalog-availability summary).
function buildBrandDirectoryReadPayload(directory, brandDirectoryAccounts) {
  const saved = serialiseBrandAccountMembership(directory.membership, directory.selectorEntries);
  const unavailableByAccount = new Map();
  for (const [id, code] of directory.catalogUnavailable) unavailableByAccount.set(id, { code, preservedLkg: false });
  for (const [id, code] of directory.catalogActionFailures) if (!unavailableByAccount.has(id)) unavailableByAccount.set(id, { code, preservedLkg: true });
  const catalogUnavailableAccounts = [...unavailableByAccount.entries()].map(([accountId, { code, preservedLkg }]) => {
    const account = (brandDirectoryAccounts || []).find((entry) => String(entry.id) === String(accountId));
    return { accountId, name: account?.name || accountId, code, preservedLkg };
  });
  const unavailableByCode = {};
  for (const { code } of catalogUnavailableAccounts) unavailableByCode[code] = (unavailableByCode[code] || 0) + 1;
  return {
    ...saved,
    membershipFingerprint: directory.fingerprint,
    accounts: brandDirectoryAccounts || [],
    source: "shared-snapshots",
    catalogUnavailableAccounts,
    catalogUnavailable: { total: catalogUnavailableAccounts.length, byCode: unavailableByCode, preservedLkg: catalogUnavailableAccounts.filter((e) => e.preservedLkg).length },
  };
}

/**
 * Serve the brand directory on a READ with a generic ZERO-EXPORT self-heal: compare the stored directory's saved
 * membership fingerprint against the live brand-sales fingerprint; serve the stored map when unchanged, else
 * rebuild it from the latest validated brand-sales (storage-first) under the shared refresh lock -- so a burst of
 * concurrent readers triggers exactly ONE rebuild -- save it atomically, and serve it. A rebuild FAILURE (or a
 * lock held by another reader) preserves and serves the previous LKG with a typed stale warning; nothing calls
 * DataDoe. This closes the rollout gap where a new scheduler brand-sales publication left the directory stale.
 */
async function serveSelfHealingBrandDirectory({ res, accountIds, legacyShared, brandDirectoryAccounts }) {
  const { reportKey, reportVersion, accountId, params } = legacyShared;
  const paramsHash = params ? paramsHashFor(reportVersion, params) : null;
  const stored = await getLatestReportSnapshot({ reportKey, accountId }).catch(() => null);
  const storedPayload = stored?.payload || null;
  const storedHasBrands = Array.isArray(storedPayload?.brands) && storedPayload.brands.length > 0;
  const storedFp = storedPayload?.membershipFingerprint;
  const liveFp = await brandSalesFingerprint(accountIds).catch(() => null);

  const serveStored = (extra = {}) => res.status(200).json({
    ...storedPayload, reportKey, reportVersion, paramsHash,
    snapshot: {
      savedAt: stored?.source_refreshed_at || stored?.updated_at || null, updatedAt: stored?.updated_at || null,
      shared: true, legacyDirectory: storedPayload?.membershipFingerprint == null, ...extra,
    },
  });

  // Unchanged evidence -> serve the saved directory immediately.
  if (storedHasBrands && storedFp != null && liveFp != null && storedFp === liveFp) { serveStored(); return; }

  // Changed or missing -> rebuild under the shared lock (one rebuild for concurrent readers).
  const locked = paramsHash ? await claimRefreshLock({ reportKey, accountId, paramsHash, lockSeconds: 300 }).catch(() => false) : false;
  if (!locked) {
    if (storedHasBrands) { serveStored({ staleRebuilding: true }); return; }
    res.status(200).json({ reportKey, reportVersion, paramsHash, brands: [], brandAccounts: {}, rebuilding: true, message: "Brand coverage is updating from the latest saved sales." });
    return;
  }
  try {
    // Double-check inside the lock -- the race winner may have just rebuilt it.
    const fresh = await getLatestReportSnapshot({ reportKey, accountId }).catch(() => null);
    if (Array.isArray(fresh?.payload?.brands) && fresh.payload.brands.length && liveFp != null && fresh.payload.membershipFingerprint === liveFp) {
      res.status(200).json({ ...fresh.payload, reportKey, reportVersion, paramsHash, snapshot: { savedAt: fresh.source_refreshed_at || fresh.updated_at || null, updatedAt: fresh.updated_at || null, shared: true } });
      return;
    }
    let payload;
    try {
      const directory = await sharedSnapshotBrandAccounts(accountIds);
      payload = buildBrandDirectoryReadPayload(directory, brandDirectoryAccounts);
    } catch (e) {
      if (storedHasBrands) { serveStored({ staleRebuildFailed: true }); return; }
      throw e;
    }
    if (paramsHash) {
      const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
      await saveReportSnapshot({ reportKey, accountId, paramsHash, params: { reportVersion, ...params }, payload, payloadBytes, sourceRefreshedAt: new Date().toISOString() }).catch(() => {});
    }
    res.status(200).json({ ...payload, reportKey, reportVersion, paramsHash, snapshot: { savedAt: new Date().toISOString(), updatedAt: null, shared: true, rebuilt: true } });
  } finally {
    if (locked && paramsHash) await releaseRefreshLock({ reportKey, accountId, paramsHash }).catch(() => {});
  }
}

async function saveBrandCatalogSnapshot(accountId, payload) {
  const paramsHash = paramsHashFor(BRAND_CATALOG_REPORT_VERSION, { accountId });
  const saved = await saveReportSnapshot({
    reportKey: BRAND_CATALOG_REPORT_KEY,
    accountId,
    paramsHash,
    params: { reportVersion: BRAND_CATALOG_REPORT_VERSION, accountId },
    payload,
    payloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
    sourceRefreshedAt: new Date().toISOString(),
  });
  if (saved?.id) {
    await publishSnapshotUpdate({ reportKey: BRAND_CATALOG_REPORT_KEY, accountId, paramsHash, snapshotId: saved.id }).catch(() => {});
  }
}

// Fetch + validate ONE account's Product Catalog and update its brand-catalog snapshot.
//
// Fail-closed, last-known-good preserving, typed, and once-per-action ATOMIC:
//   - a USABLE catalog (>=1 non-empty child_asin joined to a real non-empty
//     product_brand) saves catalogSyncStatus:"complete";
//   - a zero-row catalog, a catalog with NO usable child_asin -> product_brand mapping,
//     a row-cap truncation, a 404 "source not found", a timeout or any fetch error is
//     typed unavailable and NEVER counts as brand coverage;
//   - on any unavailable outcome, a PRIOR successful ("complete", non-empty) brand-catalog
//     snapshot is left BYTE-IDENTICAL (its brand map AND its source_refreshed_at are never
//     rewritten). The typed failure is recorded in a SEPARATE per-(action,account) attempt
//     row, so it still appears in the cumulative summary. An account with no prior success
//     is saved as unavailable with a typed code and NO fabricated brands.
//   - ATOMIC ONCE-PER-ACTION: the attempt is claimed with a durable lock BEFORE the
//     create-export and a durable "attempting" marker is written BEFORE the create-export.
//     Two concurrent same-(action,account) requests therefore create EXACTLY ONE export;
//     a replay (even after the outcome write fails, the invocation times out post-create,
//     or the lock has expired) creates ZERO further exports and returns the recorded
//     outcome. If the claim or the marker write fails, ZERO exports are created. An
//     unknown/attempting state is admin-safe and waits for a NEW explicit action id.
// The DataDoe/Supabase I/O is injectable so the whole policy is offline-testable; the
// live create-export always uses the short source id PRODUCT_CATALOG_SOURCE_ID.
export async function syncAccountBrandCatalog({ accountId, rawAccountId, connection, actionId = null }, deps = {}) {
  const fetchCatalog = deps.fetchCatalog || (({ apiKey, sourceId, rawAccountId: raw }) => fetchExportRowsRaw(
    apiKey, sourceId, PRODUCT_CATALOG_COLUMNS, [raw], null, null, CATALOG_ROW_LIMIT,
    { orderByColumn: "child_asin", orderByDirection: "ASC" }
  ));
  const getPriorSnapshot = deps.getPriorSnapshot || ((id) => getLatestReportSnapshot({ reportKey: BRAND_CATALOG_REPORT_KEY, accountId: id }));
  const save = deps.saveSnapshot || saveBrandCatalogSnapshot;
  const claimAttempt = deps.claimAttempt || defaultClaimCatalogAttempt;
  const releaseAttempt = deps.releaseAttempt || defaultReleaseCatalogAttempt;
  const getAttemptState = deps.getAttemptState || defaultGetCatalogAttemptState;
  const saveAttemptState = deps.saveAttemptState || defaultSaveCatalogAttemptState;
  const now = () => new Date().toISOString();

  // Read the prior LKG snapshot ONCE, to preserve it and to report preservedLkg.
  const prior = await Promise.resolve(getPriorSnapshot(accountId)).catch(() => null);
  const priorPayload = (prior && prior.payload) || null;
  const priorComplete = priorPayload?.catalogSyncStatus === "complete"
    && Array.isArray(priorPayload?.catalogBrands) && priorPayload.catalogBrands.length > 0;

  // `disposition` tells the action orchestrator whether a durable attempt state was
  // positively confirmed (so the queue may advance) or not:
  //   exported            - one export ran; the "attempting" marker was written first, so
  //                         a durable state is confirmed -> advance.
  //   recorded            - a durable TERMINAL state (complete/unavailable) already existed
  //                         (replay / prior holder finished) -> advance.
  //   in-progress         - a concurrent request still HOLDS the claim (mid-flight) -> zero
  //                         exports, keep the account unresolved.
  //   operational-failure - fail-closed stop: the claim/attempting-marker could not be
  //                         persisted, OR an "attempting" marker exists whose lock is no
  //                         longer held (uncertain/stale). Zero exports; a NEW action id is
  //                         required. "attempting" is NEVER reported as terminal recorded work.
  // Fail closed without an action id: idempotency cannot be scoped, so NO export.
  const attempting = (disposition) => ({ accountId, status: "attempting", code: CATALOG_ATTEMPT_PENDING, preservedLkg: priorComplete, skipped: true, disposition });
  if (!actionId) return attempting("operational-failure");

  const isTerminalState = (state) => state && (state.status === "complete" || state.status === "unavailable");
  // recorded() is ONLY ever called for a durable TERMINAL state, so the queue may advance.
  const recorded = (state) => {
    const wasComplete = state.status === "complete";
    return {
      accountId,
      status: wasComplete ? "complete" : "unavailable",
      code: wasComplete ? null : (SAFE_CATALOG_CODES.has(state.code) ? state.code : CATALOG_SOURCE_UNAVAILABLE),
      preservedLkg: !wasComplete && (state.preservedLkg || priorComplete),
      skipped: true,
      disposition: "recorded",
    };
  };

  // Fail-closed classification of an existing NON-terminal ("attempting") marker: is the
  // original claim still held (mid-flight -> in-progress) or not (stale/uncertain -> stop)?
  // Determined by trying to acquire the claim: a refusal means it is still held; acquiring a
  // free/expired lock proves the attempt is stale, so we release it and STOP -- never a
  // second export under the same action.
  const classifyAttempting = async () => {
    let acquired = false;
    let failed = false;
    try { acquired = Boolean(await claimAttempt(accountId, actionId)); } catch { failed = true; }
    if (failed) return attempting("operational-failure"); // cannot tell -> fail closed
    if (!acquired) return attempting("in-progress"); // the owner still holds the claim
    await Promise.resolve(releaseAttempt(accountId, actionId)).catch(() => {});
    return attempting("operational-failure"); // stale attempting with a free lock -> stop
  };

  // Durable replay guard (fast path): this account already has an attempt under THIS action.
  // A TERMINAL attempt advances; an "attempting" attempt is NEVER treated as terminal.
  const priorAttempt = await Promise.resolve(getAttemptState(accountId, actionId)).catch(() => null);
  if (isTerminalState(priorAttempt)) return recorded(priorAttempt);
  if (priorAttempt && priorAttempt.status === "attempting") return classifyAttempting();

  // ATOMIC claim BEFORE any DataDoe call. A THROW is a persistence failure (operational);
  // a REFUSAL means a concurrent request owns the claim. Either way, ZERO exports here.
  let claimed = false;
  let claimFailed = false;
  try { claimed = Boolean(await claimAttempt(accountId, actionId)); } catch { claimFailed = true; }
  if (claimFailed) return attempting("operational-failure"); // claim persistence failed -> stop
  if (!claimed) {
    // A concurrent owner holds the claim. A TERMINAL durable state means it already finished
    // (advance); an "attempting"/absent state means it is mid-flight (keep unresolved).
    const concurrent = await Promise.resolve(getAttemptState(accountId, actionId)).catch(() => null);
    if (isTerminalState(concurrent)) return recorded(concurrent);
    return attempting("in-progress");
  }

  try {
    // Re-read under the claim: a prior holder may have written a state between our fast-path
    // read and this claim. A TERMINAL state advances; a pre-existing "attempting" marker while
    // WE now hold the (free/expired) lock is stale -> stop, never a second export.
    const claimedAttempt = await Promise.resolve(getAttemptState(accountId, actionId)).catch(() => null);
    if (isTerminalState(claimedAttempt)) return recorded(claimedAttempt);
    if (claimedAttempt && claimedAttempt.status === "attempting") return attempting("operational-failure");

    // Persist the durable "attempting" marker BEFORE the create-export. If this write
    // fails, create ZERO exports and stop the action. Once written, it survives a mid-export
    // timeout and a failed outcome write, so no replay can re-export this account.
    try {
      await saveAttemptState(accountId, actionId, { status: "attempting", code: null, preservedLkg: priorComplete });
    } catch {
      return attempting("operational-failure"); // marker write failed -> zero exports, stop
    }

    let code = null;
    try {
      const rows = await fetchCatalog({ apiKey: connection.apiKey, sourceId: PRODUCT_CATALOG_SOURCE_ID, rawAccountId });
      const catalogRows = Array.isArray(rows) ? rows : [];
      if (catalogRows.length >= CATALOG_ROW_LIMIT) {
        code = CATALOG_TRUNCATED; // possibly truncated -> never trusted as complete coverage
      } else {
        const catalogBrands = usableCatalogBrands(catalogRows); // requires child_asin + real brand
        if (!catalogBrands.length) {
          code = CATALOG_EMPTY; // zero rows OR no usable child_asin -> product_brand mapping
        } else {
          await Promise.resolve(save(accountId, {
            catalogBrands, catalogSyncStatus: "complete", catalogSyncedAt: now(),
          }));
          // Record the terminal outcome. If THIS write fails, the "attempting" marker
          // remains and a replay is a safe no-op (no second export); the LKG is saved.
          await Promise.resolve(saveAttemptState(accountId, actionId, { status: "complete", code: null, preservedLkg: false })).catch(() => {});
          return { accountId, status: "complete", brandCount: catalogBrands.length, disposition: "exported" };
        }
      }
    } catch (error) {
      code = classifyCatalogError(error);
    }

    // Unavailable outcome (typed). Record it ONLY in the separate attempt row.
    if (priorComplete) {
      // Preserve the prior successful brand-catalog snapshot BYTE-FOR-BYTE: its map and
      // its source_refreshed_at are never rewritten. The typed failure lives in the
      // attempt row, so it still appears in this action's cumulative summary.
      await Promise.resolve(saveAttemptState(accountId, actionId, { status: "unavailable", code, preservedLkg: true })).catch(() => {});
      return { accountId, status: "unavailable", code, preservedLkg: true, disposition: "exported" };
    }
    // No prior success: represent unavailable with a typed code and NO fabricated brands.
    await Promise.resolve(save(accountId, {
      catalogBrands: [], catalogSyncStatus: "unavailable", catalogSyncCode: code, catalogSyncedAt: now(),
    })).catch(() => {});
    await Promise.resolve(saveAttemptState(accountId, actionId, { status: "unavailable", code, preservedLkg: false })).catch(() => {});
    return { accountId, status: "unavailable", code, preservedLkg: false, disposition: "exported" };
  } finally {
    // Release the short-lived claim as soon as this invocation is done. The DURABLE
    // attempt marker (not the lock) is what blocks same-action replays afterwards.
    await Promise.resolve(releaseAttempt(accountId, actionId)).catch(() => {});
  }
}

// Process a BOUNDED, already-sliced batch of accounts sequentially (kind to DataDoe
// rate limits within the serverless budget). Primary-only: a dormant dd-secondary
// record, or any id that does not resolve to the primary connection, is skipped
// read-only and never routed through the primary key. `deps.attemptAccount` is an
// injection seam so the queue can be driven offline without real I/O.
export async function syncBrandCatalogBatch(accountIds, connections, deps = {}) {
  const actionId = deps.actionId || null;
  const results = [];
  for (const accountId of [...new Set((accountIds || []).map(String))]) {
    if (typeof deps.attemptAccount === "function") {
      results.push(await deps.attemptAccount(accountId));
      continue;
    }
    if (!isPrimaryCatalogAccount(accountId)) continue;
    let scope;
    try {
      scope = resolveDataDoeAccountIds([accountId], connections);
    } catch {
      continue; // unresolvable/dormant -> skip read-only
    }
    if (!scope || scope.connection.id !== "primary") continue;
    results.push(await syncAccountBrandCatalog({ accountId, rawAccountId: scope.rawAccountIds[0], connection: scope.connection, actionId }, deps));
  }
  return results;
}

// SERVER-OWNED action orchestrator. The durable manifest -- not the browser cursor --
// owns the queue. One invocation attempts AT MOST ONE account (one export maximum), and
// only advances the queue once a durable attempt state is positively confirmed.
//
// Returns either { conflict: true, code } (the handler answers a plain admin-safe 409
// BEFORE any DataDoe call) or an outcome:
//   { conflict:false, manifest, next, attempted, disposition, remaining, status, operationalCode }
// where `remaining` is the AUTHORITATIVE server queue and `status` is one of
// "in-progress" | "complete" | "operational-failure".
//
// Blocker-6 behaviour is preserved: a first click derives `remaining` from THIS action's
// fresh discovery via catalogSyncEligibleAccounts, so newly connected primary accounts
// automatically join and removed accounts never do; dd-secondary is never primary.
export async function orchestrateBrandCatalogAction(input, deps = {}) {
  const {
    actionId, userId = null, isContinuation = false, clientCursor = [],
    authorizedPrimaryIds = [], directory = {}, connections = null,
  } = input || {};
  const loadManifest = deps.loadManifest || defaultLoadCatalogActionManifest;
  const saveManifest = deps.saveManifest || defaultSaveCatalogActionManifest;
  const scopeHashOf = deps.scopeHashOf || defaultCatalogScopeHash;
  const attemptOne = deps.attemptOne
    || ((accountId) => syncBrandCatalogBatch([accountId], connections, { ...deps, actionId }).then((r) => r[0] || null));
  const nowIso = deps.now || (() => new Date().toISOString());
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : (() => Date.now());

  const CONFLICT = { conflict: true, code: BRAND_DIRECTORY_ACTION_CONFLICT };
  const done = (manifest, extra = {}) => ({
    conflict: false, manifest, next: null, attempted: 0, disposition: "none",
    remaining: manifest.remaining || [], status: manifest.status,
    operationalCode: manifest.status === "operational-failure" ? (manifest.code || BRAND_DIRECTORY_ACTION_UNAVAILABLE) : null,
    ...extra,
  });
  const opFailure = (manifest) => ({
    conflict: false, manifest, next: manifest.current || null, attempted: 0, disposition: "operational-failure",
    remaining: manifest.remaining || [], status: "operational-failure",
    operationalCode: manifest.code || BRAND_DIRECTORY_ACTION_UNAVAILABLE,
  });
  const inProgress = (manifest, nextId) => ({
    conflict: false, manifest, next: nextId, attempted: 0, disposition: "in-progress",
    remaining: manifest.remaining || [], status: "in-progress", operationalCode: null,
  });
  // CAS-aware manifest write. `saveManifest` returns the NEW rev on a confirmed durable write
  // (create, or a CAS that won), `false` when the CAS LOST (a concurrent writer moved the row
  // on), and THROWS on a transport failure. Returns:
  //   { ok:true }                    -> durable write confirmed (new rev threaded onto `m`);
  //   { ok:false, conflict:true }    -> CAS lost: a concurrent transition committed first, so
  //                                     the caller must NOT report its own transition;
  //   { ok:false, conflict:false }   -> transport failure: the row is UNCHANGED.
  const writeManifest = async (m) => {
    try {
      const res = await saveManifest(actionId, m);
      if (res === false) return { ok: false, conflict: true };
      if (typeof res === "number") m.rev = res; // thread the new version for the next write
      return { ok: true };
    } catch { return { ok: false, conflict: false }; }
  };
  const opFailureUnsaved = (m) => opFailure({ ...m, status: "operational-failure", current: m.current || null, code: BRAND_DIRECTORY_ACTION_UNAVAILABLE });

  // The handler already validated the token shape and 400/409'd a missing id; fail closed.
  if (!validCatalogActionId(actionId)) return CONFLICT;

  const primaryScope = [...new Set((authorizedPrimaryIds || []).map(String).filter(isPrimaryCatalogAccount))].sort();
  const scopeHash = scopeHashOf(primaryScope);

  let manifest = await Promise.resolve(loadManifest(actionId)).catch(() => null);

  if (!manifest) {
    // A continuation must NEVER create an action implicitly (unknown/changed action id).
    if (isContinuation) return CONFLICT;
    // First explicit click: build the durable queue from THIS action's fresh discovery.
    const remaining = catalogSyncEligibleAccounts(primaryScope, directory);
    manifest = {
      actionId, userId: userId || null, scopeHash, primaryAccountIds: primaryScope,
      remaining, current: null, status: remaining.length ? "in-progress" : "complete",
      code: null, createdAt: nowIso(), updatedAt: nowIso(),
      // Far beyond any real refresh; a continuation after this marks the action expired + 409.
      expiresAt: new Date(nowMs() + BRAND_CATALOG_ACTION_ABANDON_DAYS * 86_400_000).toISOString(),
    };
    // Persist the manifest BEFORE any DataDoe call via atomic INSERT-IF-ABSENT. A CREATE CONFLICT
    // means another request already created this action (a delayed duplicate first click): create
    // ZERO exports and return a safe 409 reload -- NEVER overwrite or reopen the existing action.
    // A transport error stops with a typed operational failure (never report completion).
    const created = await writeManifest(manifest);
    if (created.conflict) return CONFLICT;
    if (!created.ok) return opFailureUnsaved(manifest);
  } else {
    // A loaded manifest MUST satisfy the shared revision invariant (positive safe integer whose
    // increment is safe). A missing/zero/negative/fractional/string/NaN/unsafe rev is a
    // corrupt/legacy row: fail closed (409) BEFORE any DataDoe call or write, and NEVER treat it
    // as new (which would bypass CAS).
    if (!isSafeSnapshotRev(manifest.rev)) return CONFLICT;
    // An existing action: validate ownership + scope BEFORE any DataDoe call. Wrong admin,
    // a changed/injected/removed scope, an unknown-but-existing action all 409.
    if (manifest.userId && userId && String(manifest.userId) !== String(userId)) return CONFLICT;
    if (String(manifest.scopeHash) !== String(scopeHash)) return CONFLICT;
    // An action past its abandon window is stale: transition it to the terminal "expired"
    // state (best-effort CAS) and reject with a 409. If the CAS loses to a concurrent
    // retention/continuation write, the row is already moving to a terminal/next state, so a
    // 409 is still correct. Retention then prunes it like any terminal.
    if (manifest.status !== "complete" && manifest.expiresAt && nowMs() > Date.parse(manifest.expiresAt)) {
      if (manifest.status !== "expired") await writeManifest({ ...manifest, status: "expired", updatedAt: nowIso() });
      return CONFLICT;
    }
    // Any already-terminal action (expired / operational-failure) rejects a continuation.
    if (manifest.status === "expired") return CONFLICT;
    if (isContinuation) {
      // The client cursor is a CONSISTENCY CHECK ONLY: it must match the server queue
      // exactly (content AND order). Injected, removed, reordered or duplicated ids 409.
      const cursor = (clientCursor || []).map(String);
      const authoritative = (manifest.remaining || []).map(String);
      if (cursor.length !== authoritative.length || cursor.some((id, i) => id !== authoritative[i])) return CONFLICT;
    } else {
      // First-click REPLAY of an already-created action: idempotent no-op, return state.
      return done(manifest);
    }
  }

  // A stopped action never auto-retries; a new explicit action id is required.
  if (manifest.status === "operational-failure") return opFailure(manifest);

  const next = (manifest.remaining || [])[0] || null;
  if (!next) {
    if (manifest.status !== "complete") {
      // Completing an empty queue must be a DURABLE CAS before we report it. A CAS conflict
      // means the action changed under us -> 409; a transport error -> never report complete
      // (typed operational; the prior queue is intact).
      const completed = { ...manifest, status: "complete", current: null, updatedAt: nowIso() };
      const w = await writeManifest(completed);
      if (w.conflict) return CONFLICT;
      if (!w.ok) return opFailureUnsaved(manifest);
      manifest = completed;
    }
    return done(manifest);
  }

  // EXACTLY ONE account this invocation (one export maximum).
  const result = await attemptOne(next);
  const disposition = (result && result.disposition) || "in-progress";

  if (disposition === "operational-failure") {
    // Claim / attempting-marker persistence failed: ZERO exports, stop the action, keep
    // `next` in the queue (never silently drop it), never report completion. A CAS conflict
    // means a concurrent transition committed first -> 409; a transport error still returns a
    // typed operational response with the prior authoritative (in-progress) queue intact.
    const stopped = { ...manifest, status: "operational-failure", current: next, code: BRAND_DIRECTORY_ACTION_UNAVAILABLE, updatedAt: nowIso() };
    const w = await writeManifest(stopped);
    if (w.conflict) return CONFLICT;
    return opFailure(w.ok ? stopped : { ...manifest, status: "operational-failure", current: next, code: BRAND_DIRECTORY_ACTION_UNAVAILABLE });
  }
  if (disposition === "in-progress") {
    // A concurrent request owns the claim: ZERO exports; do NOT advance and do NOT persist a
    // manifest write. The queue is UNCHANGED, so there is nothing to make durable, and writing
    // here would only bump the version and needlessly lose/steal the CAS race against the owner's
    // real (queue-changing) advance. The client re-continues; a later pass observes the owner's
    // durable outcome. `current` in the response is an informational hint only.
    return inProgress({ ...manifest, current: next, status: "in-progress" }, next);
  }
  // "exported" or "recorded": a durable TERMINAL attempt is positively confirmed. Advance the
  // queue ONLY if the CAS write wins. A CAS CONFLICT means a concurrent transition (e.g.
  // retention expiring the action, or another continuation) committed first -> return 409; the
  // stale continuation NEVER restores in-progress/complete over it. A transport error leaves the
  // durable terminal attempt in place, so a later continuation re-observes it (recorded) and
  // retries only the manifest transition, with ZERO new DataDoe exports.
  const remaining = (manifest.remaining || []).filter((id) => String(id) !== String(next));
  const advanced = { ...manifest, remaining, current: null, status: remaining.length ? "in-progress" : "complete", updatedAt: nowIso() };
  const w = await writeManifest(advanced);
  if (w.conflict) return CONFLICT;
  if (!w.ok) return inProgress({ ...manifest, current: next, status: "in-progress" }, next);
  return { conflict: false, manifest: advanced, next, attempted: disposition === "exported" ? 1 : 0, disposition, remaining, status: advanced.status, operationalCode: null };
}

function stableSelectionId(prefix, accountIds) {
  return `${prefix}:${[...new Set(accountIds.map(String))].sort().join(",")}`;
}

// A Brand View refresh already discovers the connected account catalogue in
// order to find its permitted brands. Persist that same catalogue so a future
// browser can establish its account scope from Supabase before it reads the
// saved Brand View directory. The accounts response still filters this shared
// record by the requesting user's permissions.
// PURE: reconcile the freshly discovered accounts with the previously saved directory.
// Discovery is the source of truth for which accounts are ACTIVE, so a brand-new account
// simply appears (active), with no code, config, or manual mapping. A previously-known
// account that is no longer discoverable is RETAINED as inactive/read-only (`active:false`)
// rather than dropped, so its record and its saved last-known-good data are never deleted;
// it is also never scheduled again (see catalogSyncEligibleAccounts, which uses discovery).
// If a removed account is rediscovered later it becomes active again. Every discovered
// account keeps its real public id (a primary raw seller id is never mutated, a secondary
// keeps its `dd-secondary:` prefix), so primary and dormant secondary records never merge.
export function mergeAccountDirectory(priorAccounts, discoveredAccounts) {
  const discovered = Array.isArray(discoveredAccounts) ? discoveredAccounts : [];
  const discoveredIds = new Set(discovered.map((account) => String(account.id)));
  const merged = discovered.map((account) => ({ ...account, active: true }));
  for (const prior of Array.isArray(priorAccounts) ? priorAccounts : []) {
    if (discoveredIds.has(String(prior.id))) continue; // superseded by the fresh discovery
    merged.push({ ...prior, active: false }); // inactive/read-only; record + LKG preserved
  }
  return merged;
}

async function persistAccountDirectory(accounts) {
  if (!isSupabaseConfigured() || !accounts.length) return;
  const reportKey = "account-directory";
  const reportVersion = "account-directory-shared-v1";
  const accountId = "__account-directory__";
  const paramsHash = paramsHashFor(reportVersion, {});
  // Merge with the prior directory so a removed/inaccessible account becomes inactive
  // (read-only) instead of vanishing, and no saved snapshot is ever deleted.
  const prior = await getLatestReportSnapshot({ reportKey, accountId }).catch(() => null);
  const payload = { accounts: mergeAccountDirectory(prior?.payload?.accounts, accounts) };
  const saved = await saveReportSnapshot({
    reportKey,
    accountId,
    paramsHash,
    params: { reportVersion },
    payload,
    payloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
    sourceRefreshedAt: new Date().toISOString(),
  });
  if (saved?.id) {
    await publishSnapshotUpdate({ reportKey, accountId, paramsHash, snapshotId: saved.id }).catch(() => {});
  }
}

// Account name and marketplace country for one account, from the shared account
// directory snapshot. Supabase only: Brand View must never call DataDoe's
// account list merely to label a row. Returns null metadata rather than failing
// when the directory has not been seeded, because the report itself does not
// depend on it.
async function sharedAccountMetadata(accountId) {
  if (!isSupabaseConfigured()) return null;
  const snapshot = await getLatestReportSnapshot({
    reportKey: "account-directory",
    accountId: "__account-directory__",
  }).catch(() => null);
  const account = (snapshot?.payload?.accounts || []).find((entry) => String(entry.id) === String(accountId));
  return account ? { name: account.name || null, country: account.country || null, currency: account.currency || null } : null;
}

/**
 * The account-scoped Brand View brand directory, cache-first.
 *
 * Deriving the list means reading this account's saved Dashboard payload, which
 * for a large account is megabytes. Doing that on every page load — and again
 * to validate the selected brand — would make the page slow for exactly the
 * accounts that need it most. So the derived list is itself saved as a small
 * shared snapshot and served from there; it is only rebuilt when nothing has
 * been derived yet or the user explicitly refreshes.
 *
 * Rebuilding needs no refresh lock: it reads Supabase only, costs nothing
 * upstream, and the write is an idempotent upsert of a deterministic result.
 */
async function brandViewDirectory(accountId, { rebuild = false } = {}) {
  const paramsHash = paramsHashFor(BRAND_VIEW_BRANDS_VERSION, { accountId });
  if (!rebuild) {
    const saved = await getReportSnapshot({ reportKey: BRAND_VIEW_BRANDS_REPORT_KEY, accountId, paramsHash });
    if (saved?.payload) {
      return {
        payload: saved.payload,
        savedAt: saved.source_refreshed_at || saved.updated_at || null,
        shared: true,
      };
    }
  }
  const payload = await buildBrandViewBrandDirectory({ accountId, getSnapshot: getLatestReportSnapshot });
  const saved = await saveReportSnapshot({
    reportKey: BRAND_VIEW_BRANDS_REPORT_KEY,
    accountId,
    paramsHash,
    params: { reportVersion: BRAND_VIEW_BRANDS_VERSION, accountId },
    payload,
    payloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
    sourceRefreshedAt: new Date().toISOString(),
  }).catch(() => null);
  return {
    payload,
    savedAt: saved?.source_refreshed_at || new Date().toISOString(),
    shared: Boolean(saved),
  };
}

// The first dashboard reports predate the shared snapshot layer. Keep their
// existing builders intact, but give them the exact same saved-data contract as
// the newer insight reports. Browser storage is now only a fast fallback.
function legacySharedDescriptor({ action, req, access, publicAccountIds, accountScope }) {
  const accountId = accountScope?.accountIds?.[0];
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  switch (action) {
    case "accounts":
      return {
        reportKey: "account-directory", reportVersion: "account-directory-shared-v1", accountId: "__account-directory__", params: {}, label: "account directory",
        present: (payload) => {
          // Inactive (removed/inaccessible) accounts are RETAINED in the durable directory
          // snapshot as read-only records, but are not offered as selectable accounts, so the
          // live selector behaves exactly as before. `active !== false` keeps legacy entries
          // (saved before this field existed) visible.
          const selectable = (payload.accounts || []).filter((account) => account.active !== false);
          return {
            ...payload,
            accounts: access.role === "admin"
              ? selectable
              : selectable.filter((account) => access.accountIds.includes(String(account.id))),
          };
        },
      };
    case "brand-directory":
      if (!publicAccountIds.length) return null;
      return {
        reportKey: "brand-directory", reportVersion: "brand-directory-shared-v2",
        accountId: stableSelectionId("brand-directory", publicAccountIds),
        params: { accountIds: [...publicAccountIds].sort().join(",") }, label: "brand directory",
      };
    case "sales":
      if (!publicAccountIds.length || !from || !to) return null;
      return {
        reportKey: "sales", reportVersion: "sales-shared-v1",
        accountId: stableSelectionId("sales", publicAccountIds), params: { from, to }, label: "sales report",
      };
    case "brand-sales":
      if (!accountId || !from || !to) return null;
      return {
        reportKey: "brand-sales", reportVersion: "brand-sales-shared-v1", accountId,
        params: { from, to }, label: "Dashboard",
      };
    case "brand-inventory":
      if (!accountId || !to) return null;
      // Compact per-account FBA inventory for Brand View. A non-refresh read serves
      // the saved Supabase snapshot only (zero DataDoe); a refresh is admin-gated in
      // the handler and creates at most ONE FBA Inventory Health export.
      return {
        reportKey: BRAND_INVENTORY_SNAPSHOT_KEY, reportVersion: BRAND_INVENTORY_REPORT_VERSION, accountId,
        params: { to }, label: "Brand View FBA inventory",
      };
    case "daily":
      if (!accountId || !from || !to) return null;
      return {
        reportKey: "daily-reporting", reportVersion: "daily-reporting-shared-v2", accountId,
        params: { from, to, brand: String(req.query.brand || "ALL") }, label: "Daily Reporting",
      };
    case "reconciliation":
      if (!accountId || !from || !to) return null;
      return { reportKey: "reconciliation", reportVersion: "reconciliation-shared-v1", accountId, params: { from, to }, label: "Reconciliation" };
    case "sku-pl":
      if (!accountId || !from || !to) return null;
      return { reportKey: "sku-pl", reportVersion: "sku-pl-shared-v1", accountId, params: { from, to }, label: "SKU P&L Analyzer" };
    case "keyword-rank":
      if (!accountId || !to) return null;
      return { reportKey: "keyword-rank", reportVersion: "keyword-rank-shared-v1", accountId, params: { to }, label: "Keyword Rank" };
    case "content-changes":
      if (!accountId) return null;
      return { reportKey: "content-changes", reportVersion: "content-changes-shared-v1", accountId, params: { asOf: String(req.query.asOf || "") }, label: "Content Change Alerts" };
    case "fba-plan":
      if (!accountId || !to) return null;
      return { reportKey: "fba-plan", reportVersion: "fba-plan-shared-v1", accountId, params: { to }, label: "FBA Shipment Plan" };
    default:
      return null;
  }
}

/**
 * Build the Dashboard (brand-sales) payload for one account, headlessly.
 *
 * Co-located here so it reuses the module-scoped source ids, columns and the
 * orderSalesByBrand/catalogBrandNames helpers in place (no risky cross-file move).
 * Shared by the `action=brand-sales` refresh handler below AND the scheduled-sync
 * report adapter (lib/server/sync/adapters/brand-sales.js), so the calculation has
 * exactly one implementation. `ids` is the account's raw seller/vendor id(s).
 */
export async function buildBrandSalesPayload({ apiKey, ids, from, to }) {
  const sellerOrVendorIds = (Array.isArray(ids) ? ids : String(ids).split(",")).filter(Boolean);
  const rawRows = await fetchExportRows(
    apiKey,
    ORDER_LINE_ITEMS_SOURCE_ID,
    ORDER_SALES_COLUMNS,
    sellerOrVendorIds,
    from,
    to,
    ORDER_SALES_ROW_LIMIT,
    { groupBy: ORDER_SALES_GROUP_BY, aggregations: ORDER_SALES_AGGREGATIONS }
  );
  const catalog = await fetchExportRows(
    apiKey,
    PRODUCT_CATALOG_SOURCE_ID,
    PRODUCT_CATALOG_COLUMNS,
    sellerOrVendorIds,
    from,
    to,
    CATALOG_ROW_LIMIT,
    { orderByColumn: "child_asin" }
  );
  // Additive ASIN->brand map from the catalog THIS refresh already fetched. It lets
  // the compact Brand View inventory refresh attribute FBA stock to brands without
  // spending a second Product Catalog export. Bounded by the account's catalog size
  // and far smaller than the row set; older snapshots simply lack it and the
  // inventory refresh then reuses the shared catalog source cache instead.
  const asinBrand = {};
  for (const c of catalog) {
    const asin = String(c.child_asin || "").trim();
    const brand = String(c.product_brand || "").trim();
    if (asin && brand && !(asin in asinBrand)) asinBrand[asin] = brand;
  }
  // VALIDATE the Product Catalog BEFORE constructing/returning the payload. A DataDoe
  // export can succeed yet be UNUSABLE for brand attribution: zero rows (the live
  // primary Catalog currently has 0 rows), or rows carrying no usable
  // child_asin -> product_brand pair. Building a snapshot then would save
  // asinBrand:{} / catalogBrands:[] over a previously valid Brand Sales snapshot and
  // lose real brand data. Fail closed here (an empty map means no usable mappings), so
  // the caller never reaches sendLegacyPayload/saveReportSnapshot and the prior snapshot
  // is preserved. Real Order Line Item sales are NOT saved as a new brand-scoped
  // snapshot when attribution is unavailable, and "Unassigned" is never a real brand.
  if (Object.keys(asinBrand).length === 0) {
    const error = new Error("Product Catalog has no usable brand mappings yet. Previous saved Brand Sales data was preserved.");
    error.brandSalesUnavailable = true;
    throw error;
  }
  const rows = orderSalesByBrand(rawRows, catalog);
  // Derive the brand list from the account's already-joined sales rows, never
  // from wider catalog metadata, so the header brand filter cannot exceed scope.
  return { rows, catalogBrands: catalogBrandNames(rows), asinBrand };
}

async function discoverConnectedAccounts(connections) {
  const accountsByConnection = [];
  for (const connection of connections) {
    const discovered = await fetchAccountsRaw(connection.apiKey);
    accountsByConnection.push({ connection, accounts: discovered });
  }
  return mergeDiscoveredDataDoeAccounts(accountsByConnection);
}

// Amazon SP-API BRANDED_ITEM_CONTENT_CHANGE notifications. This real-time
// source reports changes to A+ / branded item content after Amazon publishes
// them. Its payload is intentionally normalised before it reaches the browser:
// notification payloads vary by Amazon event version and can be very large.
const CONTENT_CHANGE_SOURCE_ID = "aec3d5976911a7a80110c08801a741e4f0a25dd997d639f5d918284d905a4758";
const CONTENT_CHANGE_COLUMNS = [
  "event_time",
  "sp_api_notification_id",
  "sp_api_notification_type",
  "notification_metadata",
  "payload",
];

// Daily Reporting sales source: "Order Line Items" (89b27535...), the canonical
// ordered-sales/units source (item_price_value for sales, quantity for ordered
// units). item_price_currency is in the group-by so DataDoe never sums money across
// currencies; the fold keeps each currency isolated. (Aliases total_sales_sum/
// total_units_sum are preserved so the downstream folds are unchanged except for
// currency isolation.)
const DAILY_SALES_SOURCE_ID = "89b27535d27c2a94db5ae39af4717f542624ff4df7802fd633e16c78674a1778";
// DAILY_SALES_COLUMNS is retained only for the /datadoe pass-through debug handler; the compact all-brand
// export (with DAILY_SALES_GROUP_BY) was removed in Blocker 1 -- all-brand now derives from the canonical
// Order Line Items superset (fetchDailyBrandSalesRows + rollupSupersetToDaily).
const DAILY_SALES_COLUMNS = [
  "date",
  "seller_or_vendor_id",
  "item_price_currency",
];
const DAILY_SALES_AGGREGATIONS = [
  { column: "item_price_value", aggregation: "sum", alias: "total_sales_sum" },
  { column: "quantity", aggregation: "sum", alias: "total_units_sum" },
];
// A named brand needs ASIN-level grouping before it can be joined to the Product Catalog. The all-brand
// report keeps the more compact date grouping. Both carry item_price_currency for currency isolation.
// The named-brand superset IS the CANONICAL Order Line Items sales fragment (Blocker 1): grouped by
// [date, seller, sku, child_asin, item_price_currency] so it is byte-identical to OLI_SALES_* and shares
// request_hashes with fba-plan / buy-box-loss / returns-leakage / ppc-performance on overlapping slices.
const DAILY_BRAND_SALES_COLUMNS = ["date", "seller_or_vendor_id", "sku", "child_asin", "item_price_currency"];
const DAILY_BRAND_SALES_GROUP_BY = ["date", "seller_or_vendor_id", "sku", "child_asin", "item_price_currency"];

// ===== CANONICAL Order Line Items sales fragment (Blocker 1 — parity source of truth) =====
// ONE fragment spec shared IDENTICALLY by daily-reporting (the superset above), fba-plan, buy-box-loss,
// returns-leakage and ppc-performance so overlapping calendar-anchored slices (canonicalOliSlices) produce
// EQUAL request_hashes => one DataDoe export reused by MULTIPLE report owners. Mirrored in
// lib/server/sync/report-source-contracts.js (OLI_SALES_*) and referenced by the live builders in
// lib/server/reports/{buy-box,returns,ppc}.js. item_price_currency is in the group-by so DataDoe never sums
// money across currencies; every downstream fold keys currency in and re-aggregates to its own grain.
const OLI_SALES_COLUMNS = ["date", "seller_or_vendor_id", "sku", "child_asin", "item_price_currency"];
const OLI_SALES_GROUP_BY = ["date", "seller_or_vendor_id", "sku", "child_asin", "item_price_currency"];
const OLI_SALES_AGGREGATIONS = [
  { column: "item_price_value", aggregation: "sum", alias: "total_sales_sum" },
  { column: "quantity", aggregation: "sum", alias: "total_units_sum" },
];
const OLI_SALES_ROW_LIMIT = 50000;

// Advertising source (ad sales / spend / clicks), merged into the daily report by (account, date, currency).
// ad_campaign_budget_currency is carried + normalized to `currency` (Blocker 4) so the currency-keyed
// mergeSalesAndAds only merges an Ads row into the OLI sales row of the SAME currency; a blank/unprovable
// Ads currency becomes null and never merges (fail-closed: the sales row simply shows no ads).
// The DataDoe ASIN Ads source (asin-performance-v1) -- the SINGLE reusable Ads grain. Server-side aggregated
// to per-(date, seller, currency) totals so the REST fallback matches the Supabase/scheduler path exactly:
// attributed sales is ad_sales_same_sku (same-SKU only; no campaign halo), aliased to ad_sales_sum.
const ADS_SOURCE_ID = "d0017e92fb089c2c8c3fe65f81d08666ecb4fe937ffbce9969ce2fc7d28c805c";
const ADS_COLUMNS = [
  "date",
  "seller_or_vendor_id",
  "ad_campaign_budget_currency",
];
const ADS_GROUP_BY = ["date", "seller_or_vendor_id", "ad_campaign_budget_currency"];
const ADS_AGGREGATIONS = [
  { column: "ad_sales_same_sku", aggregation: "sum", alias: "ad_sales_sum" },
  { column: "ad_spend", aggregation: "sum", alias: "ad_spend_sum" },
  { column: "ad_clicks", aggregation: "sum", alias: "ad_clicks_sum" },
];

// Amazon Reconciliation Dashboard. These sources are intentionally kept at
// order / settlement-event grain so the browser can make cross-month timing
// visible instead of comparing incompatible daily aggregates.
const RECONCILIATION_SETTLEMENTS_SOURCE_ID = "732dac689a6545697c2f2e36c61b2c9e93187053bcce2999914183c6f490df27";
const RECONCILIATION_ORDER_COLUMNS = [
  "date", "order_date", "amazon_order_id", "child_asin", "amazon_order_status",
  "fulfillment_channel", "order_is_business", "item_price_currency",
];
const RECONCILIATION_ORDER_GROUP_BY = [...RECONCILIATION_ORDER_COLUMNS];
const RECONCILIATION_ORDER_AGGREGATIONS = [
  { column: "quantity", aggregation: "sum", alias: "quantity_sum" },
  { column: "item_price_value", aggregation: "sum", alias: "item_price_sum" },
  { column: "item_tax_value", aggregation: "sum", alias: "item_tax_sum" },
];
const RECONCILIATION_SETTLEMENT_COLUMNS = ["date", "amazon_order_id", "settlement_type", "currency"];
const RECONCILIATION_SETTLEMENT_GROUP_BY = [...RECONCILIATION_SETTLEMENT_COLUMNS];
const RECONCILIATION_SETTLEMENT_AGGREGATIONS = [
  { column: "item_price", aggregation: "sum", alias: "item_price_sum" },
  { column: "item_tax", aggregation: "sum", alias: "item_tax_sum" },
  { column: "referral_fee", aggregation: "sum", alias: "referral_fee_sum" },
  { column: "fba_per_unit_fulfillment_fee", aggregation: "sum", alias: "fba_fee_sum" },
  { column: "refunded_amount", aggregation: "sum", alias: "refunded_amount_sum" },
  { column: "total", aggregation: "sum", alias: "total_sum" },
];
// ===== SKU P&L Analyzer source =====
// "Profit by SKU & Date" (57a0...) is DataDoe's canonical Premium P&L table: it
// already pre-joins settlements, COGS, and advertising, so `profit` is trusted
// directly and never rebuilt from raw orders/settlements. Aggregated per SKU with
// enough grouping (child_asin/product_name/product_brand/currency) to support
// local product, brand, and currency filtering. Ratio columns (acos/tacos/roi)
// are deliberately NOT summed — the browser recomputes ratios from the sums.
const SKU_PL_SOURCE_ID = "57a0cb319c10a395853afc0671579bf7ef0ff45d8a40c88ed9d2a5f61b4169a4";
const SKU_PL_GROUP_BY = ["sku", "child_asin", "product_name", "product_brand", "currency"];
const SKU_PL_COLUMNS = [...SKU_PL_GROUP_BY];
const SKU_PL_AGGREGATIONS = [
  { column: "total_sales", aggregation: "sum", alias: "total_sales_sum" },
  { column: "profit", aggregation: "sum", alias: "profit_sum" },
  { column: "total_cost", aggregation: "sum", alias: "total_cost_sum" },
  { column: "ad_spend", aggregation: "sum", alias: "ad_spend_sum" },
  { column: "total_fees", aggregation: "sum", alias: "total_fees_sum" },
  { column: "cogs_total", aggregation: "sum", alias: "cogs_total_sum" },
  { column: "total_units_sold", aggregation: "sum", alias: "units_sum" },
];
const SKU_PL_ROW_LIMIT = 50000;

// ===== Keyword Rank & Share Tracker sources =====
// Search Query Performance is Amazon Brand Analytics data at the exact
// child-ASIN/query/period grain needed for organic-rank and share-of-query
// monitoring. These tables are not default data sources, so the action below
// turns an organisation-disabled response into an actionable setup message.
const SQP_WEEKLY_SOURCE_ID = "81aa5b4cc248bb70de405b9ff9d51290b9232f84570d76ba2a1289b67b6595fb";
const SQP_MONTHLY_SOURCE_ID = "df4160ff8e1add239172a69ebd6c8abfec7116ee4a17720983757b1b55599830";
const SQP_COLUMNS = [
  "date",
  "child_asin",
  "search_query",
  "search_query_volume",
  "search_query_total_impression_count",
  "search_query_total_click_count",
  "search_query_total_purchase_count",
  "child_asin_impression_count",
  "child_asin_click_count",
  "child_asin_purchase_count",
  "child_asin_organic_search_rank",
];
const SQP_ROW_LIMIT = 50000;
const SQP_WEEKLY_LOOKBACK_DAYS = 84;
const SQP_MONTHLY_LOOKBACK_DAYS = 365;

// ===== FBA Shipment Plan sources (verified against api/v1/spec/data-scheme) =====
// Per-ASIN ordered units. "Order Line Items" (89b27535...) exposes child_asin +
// quantity (ordered units) and is the canonical sales/demand source. It is used
// here for the 3 completed months and current-month MTD unit velocity.
const PLAN_SALES_SOURCE_ID = "89b27535d27c2a94db5ae39af4717f542624ff4df7802fd633e16c78674a1778";
// Live FBA inventory snapshot. "FBA Inventory Health" (44fc5ba0...) is the only
// source that splits reserved into reserved_fc_transfer / reserved_fc_processing
// / reserved_customer_order and splits inbound into working / shipped / received,
// which is exactly what the shipment-plan definition requires. It is per SKU per
// snapshot date; the latest snapshot date is kept and SKUs are folded to ASIN.
const FBA_HEALTH_SOURCE_ID = "44fc5ba0ce81a7807601f6d7a9b8b7aaec64be4c7e046ea30dc6864d1a4aa823";
const FBA_HEALTH_COLUMNS = [
  "date",
  "marketplace_country_code",
  "child_asin",
  "sku",
  "fnsku",
  "product_name",
  "available",
  "reserved_fc_transfer",
  "reserved_fc_processing",
  "inbound_working",
  "inbound_shipped",
  "inbound_received",
];
// AWD available inventory (US marketplace only). The "Listings" source
// (ba689c05...) exposes awd_available_distributable_quantity per SKU. Listings
// has no date column, so its exports must not send a date range or a date
// orderBy.
const LISTINGS_SOURCE_ID = "ba689c05d7f7cee1a1690990c28995680a0654b7ed258230f4173d61bbcd1ab3";
const LISTINGS_AWD_COLUMNS = [
  "child_asin",
  "sku",
  "fnsku",
  "awd_available_distributable_quantity",
];
// Inventory Health is a daily snapshot; look back a short window and keep the
// latest snapshot date. DESC ordering guarantees the full latest snapshot is at
// the front of the result, so the row limit only ever drops older snapshots.
const PLAN_INVENTORY_LOOKBACK_DAYS = 10;
const PLAN_INVENTORY_ROW_LIMIT = 15000;

const DASHBOARD_ROW_LIMIT = 5000;
// Order rows are grouped by day and ASIN before download. A year of data can
// still contain more than 5,000 ASIN/day groups, so use a higher export cap.
const ORDER_SALES_ROW_LIMIT = 50000;
const CATALOG_ROW_LIMIT = 10000;
// Daily sources are aggregated by account/date before download, so a compact
// limit safely covers years of history without raw ASIN row truncation.
const DAILY_ROW_LIMIT = 5000;
const DAILY_BRAND_ROW_LIMIT = 50000;
const RECONCILIATION_ROW_LIMIT = 50000;
const CONTENT_CHANGE_ROW_LIMIT = 1000;

function sqpDistinctPeriods(rows) {
  return [...new Set(rows.map((row) => String(row.date || "")).filter(Boolean))].sort();
}

async function fetchSqpRows(apiKey, sourceId, sellerOrVendorIds, from, to) {
  const rows = await fetchExportRows(
    apiKey, sourceId, SQP_COLUMNS, sellerOrVendorIds, from, to, SQP_ROW_LIMIT,
    { orderByColumn: "date", orderByDirection: "ASC" }
  );
  // A full result exactly at the cap is indistinguishable from a truncated one.
  // Refuse to save a misleading keyword trend rather than silently dropping
  // long-tail terms from the money-keyword watch list.
  if (rows.length >= SQP_ROW_LIMIT) {
    throw new Error(`Search Query Performance export reached the ${SQP_ROW_LIMIT.toLocaleString("en-US")} row cap. The Keyword Rank report was not saved because a partial keyword history would be misleading.`);
  }
  return rows;
}

// Exported so an INDEPENDENT parity harness (scripts/scheduler-v2-report-derivation.test.mjs)
// can execute this production fold and the extracted pure copy in
// lib/server/reports/derivation-core.js side by side and assert they never drift. Runtime
// behavior is unchanged (adding `export` only).
export function orderSalesByBrand(rows, catalogRows) {
  const brandByAsin = new Map();
  for (const catalogRow of catalogRows) {
    const asin = String(catalogRow.child_asin || "").trim();
    const brand = String(catalogRow.product_brand || "").trim();
    if (asin && brand) brandByAsin.set(asin, brand);
  }

  // The export is compact at date/ASIN grain. Join the catalog brand and fold
  // those ASIN rows again so the browser receives only date/brand totals.
  const totals = new Map();
  for (const row of rows) {
    const productBrand = brandByAsin.get(String(row.child_asin || "").trim()) || "Unassigned";
    const currency = row.item_price_currency || row.currency || null;
    const key = [
      row.date,
      row.seller_or_vendor_id,
      row.seller_or_vendor_name,
      row.marketplace_country_code,
      currency,
      productBrand,
    ].join("|");
    const current = totals.get(key) || {
      date: row.date,
      seller_or_vendor_id: row.seller_or_vendor_id,
      seller_or_vendor_name: row.seller_or_vendor_name,
      marketplace_country_code: row.marketplace_country_code,
      currency,
      product_brand: productBrand,
      total_sales: 0,
      total_units_sold: 0,
      unpriced_units: 0,
      // A compact ASIN-level export cannot deduplicate order IDs across ASINs.
      // Leave Orders/AOV unavailable rather than showing a misleading value.
      total_orders: null,
    };
    const sales = num(row.total_sales_sum ?? row.item_price_value);
    const units = num(row.total_units_sold_sum ?? row.quantity);
    current.total_sales += sales;
    current.total_units_sold += units;
    // A zero-valued group with units is an upstream order-data completeness
    // signal. Preserve it so the UI can warn instead of silently understating
    // sales when Amazon/DataDoe has not populated an item price yet.
    if (sales === 0 && units > 0) current.unpriced_units += units;
    totals.set(key, current);
  }
  return [...totals.values()];
}

// Exported so the Scheduler v2 Daily Reporting derivation can run the SAME normalization
// independently for its route-vs-shadow parity harness (runtime unchanged).
export function normalizeDailySalesRows(rows) {
  return rows.map((row) => ({
    ...row,
    // Carry the Order Line Items currency so downstream keeps each currency isolated.
    currency: row.currency ?? row.item_price_currency ?? null,
    total_sales: num(row.total_sales_sum ?? row.item_price_value),
    total_units: num(row.total_units_sum ?? row.quantity),
  }));
}

// Fold the ASIN-level canonical OLI superset to one row per (date, seller, currency). Byte-identical twin
// of lib/server/reports/derivation-core.js rollupSupersetToDaily (kept as a separate copy under the same
// twin discipline as normalizeDailySalesRows / dailyRowsForBrand). The all-brand Daily Reporting rows are
// derived from THIS rollup of the SAME superset the named-brand path fetches, so the live route matches the
// scheduler for both modes (Blocker 1) and no separate compact all-brand export is spent.
export function rollupSupersetToDaily(supersetRows) {
  const byKey = new Map();
  for (const row of supersetRows) {
    // Currency isolation: sum the superset per (date, seller, currency) -- never across currencies.
    const currency = row.currency ?? row.item_price_currency ?? null;
    const key = `${row.date}|${row.seller_or_vendor_id}|${currency ?? ""}`;
    const current = byKey.get(key) || {
      date: row.date,
      seller_or_vendor_id: row.seller_or_vendor_id,
      currency,
      total_sales_sum: 0,
      total_units_sum: 0,
    };
    current.total_sales_sum += num(row.total_sales_sum ?? row.item_price_value);
    current.total_units_sum += num(row.total_units_sum ?? row.quantity);
    byKey.set(key, current);
  }
  return [...byKey.values()];
}

// Join the ASIN-level daily export to the account's catalog, then fold the
// chosen brand back to one row per day for the existing Daily Reporting table.
// Exported for the Scheduler v2 named-brand derivation parity harness.
export function dailyRowsForBrand(rows, catalogRows, brand) {
  const brandByAsin = new Map();
  for (const catalogRow of catalogRows) {
    const asin = String(catalogRow.child_asin || "").trim();
    const productBrand = String(catalogRow.product_brand || "").trim();
    if (asin && productBrand && !brandByAsin.has(asin)) brandByAsin.set(asin, productBrand);
  }
  const totals = new Map();
  for (const row of rows) {
    if (brandByAsin.get(String(row.child_asin || "").trim()) !== brand) continue;
    // Currency isolation: a (seller, date) pair is folded per currency, never across.
    const currency = row.currency ?? row.item_price_currency ?? null;
    const key = `${row.seller_or_vendor_id}|${row.date}|${currency ?? ""}`;
    const current = totals.get(key) || {
      date: row.date,
      seller_or_vendor_id: row.seller_or_vendor_id,
      currency,
      total_sales: 0,
      total_units: 0,
      total_units_sold: 0,
    };
    current.total_sales += num(row.total_sales_sum ?? row.item_price_value);
    current.total_units += num(row.total_units_sum ?? row.quantity);
    current.total_units_sold = current.total_units;
    totals.set(key, current);
  }
  return [...totals.values()];
}

// Exported for the Scheduler v2 Daily Reporting derivation parity harness (runtime unchanged).
// Blocker 4: normalize the Ads currency from ad_campaign_budget_currency into `currency` (canonical
// UPPERCASE, or null when blank/unprovable) so the currency-keyed mergeSalesAndAds only merges an Ads
// row into the OLI sales row of the SAME currency. A currency-less Ads row (currency === null) never
// merges into a currency'd sales row (fail-closed: no misleading cross-currency merge). An already-
// normalized `currency` (e.g. the Supabase-saved ad rows) is preserved.
export function normalizeAdRows(rows) {
  return rows.map((row) => ({
    ...row,
    currency: (row.currency != null && String(row.currency).trim() !== "")
      ? String(row.currency).trim().toUpperCase()
      : (String(row.ad_campaign_budget_currency || "").trim().toUpperCase() || null),
    ad_sales: num(row.ad_sales_sum ?? row.ad_sales),
    ad_spend: num(row.ad_spend_sum ?? row.ad_spend),
    ad_clicks: num(row.ad_clicks_sum ?? row.ad_clicks),
  }));
}

export function catalogBrandNames(rows) {
  // A successful but zero-row (or fully unmapped) Product Catalog must NOT fabricate a
  // brand: rows fold unmapped ASINs into the "Unassigned" placeholder, which is not a
  // real brand and is excluded here (as the Brand directory already excludes it), so an
  // empty/unavailable catalog yields no brands rather than a fake one.
  return [...new Set(
    rows
      .map((row) => String(row.product_brand || "").trim())
      .filter((name) => name && name !== "Unassigned")
  )].sort((a, b) => a.localeCompare(b));
}

function parseJsonValue(value) {
  if (!value || typeof value !== "string") return value;
  try { return JSON.parse(value); } catch (e) { return value; }
}

function compactJsonPreview(value, maxLength = 420) {
  const parsed = parseJsonValue(value);
  const text = typeof parsed === "string" ? parsed : JSON.stringify(parsed || {});
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

// DataDoe passes through Amazon notification payloads whose nesting changes
// over time. Find ASIN values by semantic key names as well as any exact ASIN
// pattern in strings, so known payload variants remain brand-filterable.
function notificationAsins(value) {
  const found = new Set();
  const visit = (node, key = "") => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      const text = node.trim();
      if (/asin/i.test(key) && /^[A-Z0-9]{10}$/i.test(text)) found.add(text.toUpperCase());
      const matches = text.match(/\b[A-Z0-9]{10}\b/gi) || [];
      matches.forEach((match) => found.add(match.toUpperCase()));
      return;
    }
    if (Array.isArray(node)) { node.forEach((item) => visit(item, key)); return; }
    if (typeof node === "object") Object.entries(node).forEach(([childKey, child]) => visit(child, childKey));
  };
  visit(parseJsonValue(value));
  return [...found].sort();
}

export function compactContentChangeEvents(rows, catalogRows) {
  const brandByAsin = new Map();
  for (const catalogRow of catalogRows) {
    const asin = String(catalogRow.child_asin || "").trim().toUpperCase();
    const brand = String(catalogRow.product_brand || "").trim();
    if (asin && brand && !brandByAsin.has(asin)) brandByAsin.set(asin, brand);
  }
  return rows.map((row) => {
    const asins = notificationAsins(row.payload);
    const brands = [...new Set(asins.map((asin) => brandByAsin.get(asin)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return {
      eventTime: row.event_time || null,
      notificationId: String(row.sp_api_notification_id || "").trim() || null,
      notificationType: String(row.sp_api_notification_type || "BRANDED_ITEM_CONTENT_CHANGE").trim(),
      asins,
      brands,
      metadataPreview: compactJsonPreview(row.notification_metadata),
      payloadPreview: compactJsonPreview(row.payload),
    };
  }).sort((a, b) => String(b.eventTime || "").localeCompare(String(a.eventTime || "")));
}

/* ===== FBA Shipment Plan helpers =====
   Date and range helpers now live in lib/server/datadoe.js so the insight
   reports share exactly the same UTC string arithmetic. */

function reconciliationOrders(rows, catalogRows) {
  const brandByAsin = new Map();
  for (const row of catalogRows) {
    const asin = String(row.child_asin || "").trim();
    const brand = String(row.product_brand || "").trim() || "Unassigned";
    if (asin && !brandByAsin.has(asin)) brandByAsin.set(asin, brand);
  }
  const byOrder = new Map();
  for (const row of rows) {
    const orderId = String(row.amazon_order_id || "").trim();
    if (!orderId) continue;
    const brand = brandByAsin.get(String(row.child_asin || "").trim()) || "Unassigned";
    const current = byOrder.get(orderId) || {
      orderId,
      orderDate: row.order_date || row.date || null,
      status: row.amazon_order_status || "Unknown",
      fulfillmentChannel: row.fulfillment_channel || "Unknown",
      isBusiness: row.order_is_business === true || String(row.order_is_business).toLowerCase() === "true",
      currency: row.item_price_currency || null,
      quantity: 0,
      orderRevenue: 0,
      orderTax: 0,
      brandBreakdown: {},
    };
    const quantity = num(row.quantity_sum ?? row.quantity);
    const revenue = num(row.item_price_sum ?? row.item_price_value);
    const tax = num(row.item_tax_sum ?? row.item_tax_value);
    current.quantity += quantity;
    current.orderRevenue += revenue;
    current.orderTax += tax;
    const brandTotal = current.brandBreakdown[brand] || { quantity: 0, orderRevenue: 0, orderTax: 0 };
    brandTotal.quantity += quantity;
    brandTotal.orderRevenue += revenue;
    brandTotal.orderTax += tax;
    current.brandBreakdown[brand] = brandTotal;
    byOrder.set(orderId, current);
  }
  // The browser only needs the list of brands: named-brand reconciliation
  // accepts single-brand orders and intentionally excludes mixed-brand orders
  // because settlement entries cannot be split reliably by item. Do not send
  // duplicate per-brand monetary maps for every order in a large six-month
  // payload.
  return [...byOrder.values()].map(({ brandBreakdown, ...order }) => ({
    ...order,
    brands: Object.keys(brandBreakdown),
  }));
}

function reconciliationSettlements(rows) {
  return rows.map((row) => ({
    settlementDate: row.date || null,
    orderId: String(row.amazon_order_id || "").trim() || null,
    settlementType: String(row.settlement_type || "OTHER").trim().toUpperCase(),
    currency: row.currency || null,
    settledRevenue: num(row.item_price_sum ?? row.item_price),
    settledTax: num(row.item_tax_sum ?? row.item_tax),
    referralFee: num(row.referral_fee_sum ?? row.referral_fee),
    fbaFee: num(row.fba_fee_sum ?? row.fba_per_unit_fulfillment_fee),
    refundedAmount: num(row.refunded_amount_sum ?? row.refunded_amount),
    netPayout: num(row.total_sum ?? row.total),
  }));
}

async function reconciliationRowsByMonth(apiKey, sourceId, columns, ids, from, to, aggregations, groupBy) {
  const result = [];
  for (const window of splitDateRangeByMonth(from, to)) {
    const rows = await fetchExportRows(
      apiKey, sourceId, columns, ids, window.from, window.to, RECONCILIATION_ROW_LIMIT,
      { groupBy, aggregations, orderByColumn: "date", orderByDirection: "ASC" }
    );
    // Exact row-cap results are unsafe: the API may have truncated more data.
    if (rows.length >= RECONCILIATION_ROW_LIMIT) {
      throw new Error(`Reconciliation export reached the ${RECONCILIATION_ROW_LIMIT.toLocaleString("en-US")} row cap for ${window.from.slice(0, 7)}. The report was not saved because a partial reconciliation would be misleading.`);
    }
    result.push(...rows);
  }
  return result;
}

// Fetch Profit by SKU & Date in monthly batches and fold to one row per
// (currency|sku|child_asin), with per-month numeric sums kept under `byMonth`.
// Each month is aggregated server-side by DataDoe; hitting the row cap throws so
// a truncated (misleading) P&L is never returned as complete.
// PURE fold: combine per-month SKU P&L batches into one row per (currency|sku|child_asin) with
// per-month numeric sums under `byMonth`. Extracted verbatim from the fetch loop below and
// exported so the Scheduler v2 SKU P&L derivation runs the IDENTICAL fold independently for its
// route-vs-shadow parity harness. `monthlyBatches`: [{ monthKey, rows }] in canonical (window)
// order; the fold is additive per bucket, and entry insertion/order matches the batch+row order.
export function foldSkuPlMonthlyRows(monthlyBatches) {
  const combined = new Map();
  for (const { monthKey, rows } of monthlyBatches) {
    for (const row of rows) {
      const sku = String(row.sku || "").trim();
      const childAsin = String(row.child_asin || "").trim();
      const currency = String(row.currency || "").trim() || null;
      // Never merge across currencies: currency is part of the identity key.
      const key = `${currency || "?"}|${sku}|${childAsin}`;
      let entry = combined.get(key);
      if (!entry) {
        entry = {
          sku: sku || null,
          asin: childAsin || null,
          productName: String(row.product_name || "").trim() || null,
          brand: String(row.product_brand || "").trim() || null,
          currency,
          byMonth: {},
        };
        combined.set(key, entry);
      }
      // Fill missing product name/brand from any month that has them.
      if (!entry.productName) entry.productName = String(row.product_name || "").trim() || null;
      if (!entry.brand) entry.brand = String(row.product_brand || "").trim() || null;
      const bucket = entry.byMonth[monthKey] || { sales: 0, profit: 0, cost: 0, adSpend: 0, fees: 0, cogs: 0, units: 0 };
      bucket.sales += num(row.total_sales_sum ?? row.total_sales);
      bucket.profit += num(row.profit_sum ?? row.profit);
      bucket.cost += num(row.total_cost_sum ?? row.total_cost);
      bucket.adSpend += num(row.ad_spend_sum ?? row.ad_spend);
      bucket.fees += num(row.total_fees_sum ?? row.total_fees);
      bucket.cogs += num(row.cogs_total_sum ?? row.cogs_total);
      bucket.units += num(row.units_sum ?? row.total_units_sold);
      entry.byMonth[monthKey] = bucket;
    }
  }
  return [...combined.values()];
}

async function fetchSkuPlRows(apiKey, sellerOrVendorIds, windows) {
  const monthlyBatches = [];
  for (const window of windows) {
    const monthKey = window.from.slice(0, 7);
    const rows = await fetchExportRows(
      apiKey, SKU_PL_SOURCE_ID, SKU_PL_COLUMNS, sellerOrVendorIds, window.from, window.to, SKU_PL_ROW_LIMIT,
      { groupBy: SKU_PL_GROUP_BY, aggregations: SKU_PL_AGGREGATIONS, orderByColumn: "sku", orderByDirection: "ASC" }
    );
    if (rows.length >= SKU_PL_ROW_LIMIT) {
      throw new Error(`SKU P&L export reached the ${SKU_PL_ROW_LIMIT.toLocaleString("en-US")} row cap for ${monthKey}. The report was not saved because a partial P&L would be misleading.`);
    }
    monthlyBatches.push({ monthKey, rows });
  }
  return foldSkuPlMonthlyRows(monthlyBatches);
}

async function fetchDailyBrandSalesRows(apiKey, sellerOrVendorIds, from, to) {
  const allRows = [];
  // Blocker 1: slice by canonicalOliSlices (calendar-anchored bins [1-7],[8-14],[15-21],[22-28],[29-end])
  // and fetch each slice with the EXACT canonical Order Line Items spec (OLI_SALES_COLUMNS / GROUP_BY /
  // AGGREGATIONS, orderByColumn:"date" / orderByDirection:"ASC" passed EXPLICITLY). This makes the live
  // named-brand + all-brand superset byte-identical in request identity to the scheduler
  // daily-reporting:oli-sales fragments, so overlapping slices reuse ONE DataDoe export across the five
  // OLI reports. DAILY_BRAND_SALES_COLUMNS/GROUP_BY and DAILY_BRAND_ROW_LIMIT are byte-equal to their
  // OLI_SALES_* counterparts; the strict cap keeps the daily constant name.
  for (const window of canonicalOliSlices(from, to)) {
    const rows = await fetchExportRows(
      apiKey,
      DAILY_SALES_SOURCE_ID,
      OLI_SALES_COLUMNS,
      sellerOrVendorIds,
      window.from,
      window.to,
      DAILY_BRAND_ROW_LIMIT,
      { groupBy: OLI_SALES_GROUP_BY, aggregations: OLI_SALES_AGGREGATIONS, orderByColumn: "date", orderByDirection: "ASC" }
    );
    // Strict: a slice exactly at the row cap is indistinguishable from a truncated
    // one. Reject it BEFORE appending, so an understated all-brand / named-brand
    // total is never derived or saved; the previous good snapshot is preserved.
    if (rows.length >= DAILY_BRAND_ROW_LIMIT) {
      throw new Error(`Daily Reporting sales export reached the ${DAILY_BRAND_ROW_LIMIT.toLocaleString("en-US")} row cap for ${window.from.slice(0, 7)}. The report was not saved because a partial month would understate brand and all-brand totals.`);
    }
    allRows.push(...rows);
  }
  return allRows;
}

// The 3 completed calendar months before the month containing `toStr`, plus the
// current (MTD) month window ending at `toStr`.
function planMonthWindows(toStr) {
  const [ty, tm] = toStr.split("-").map(Number);
  const completed = [];
  for (let i = 3; i >= 1; i--) {
    const total = ty * 12 + (tm - 1) - i;
    const y = Math.floor(total / 12), m = (((total % 12) + 12) % 12) + 1;
    completed.push({
      key: `${y}-${pad2s(m)}`,
      from: `${y}-${pad2s(m)}-01`,
      to: `${y}-${pad2s(m)}-${pad2s(daysInMonthUTC(y, m))}`,
    });
  }
  const current = {
    key: `${ty}-${pad2s(tm)}`,
    from: `${ty}-${pad2s(tm)}-01`,
    to: toStr,
    daysInMonth: daysInMonthUTC(ty, tm),
  };
  return { completed, current };
}

// Fold advertising rows (ad_sales/ad_spend/ad_clicks) into the sales rows by
// (account, date). Ad totals attach to the first sales row for each key so
// downstream range sums count them exactly once; days with ad activity but no
// sales row get a synthetic zero-sales row.
// Exported for the Scheduler v2 Daily Reporting derivation parity harness (runtime unchanged).
export function mergeSalesAndAds(salesRows, adRows) {
  const firstByKey = new Map();
  for (const r of salesRows) {
    // Currency isolation: ad rows only merge into the sales row of the SAME currency.
    const key = `${r.seller_or_vendor_id}|${r.date}|${r.currency ?? ""}`;
    if (!firstByKey.has(key)) firstByKey.set(key, r);
  }
  for (const a of adRows) {
    const key = `${a.seller_or_vendor_id}|${a.date}|${a.currency ?? ""}`;
    const target = firstByKey.get(key);
    if (target) {
      target.ad_sales = num(target.ad_sales) + num(a.ad_sales);
      target.ad_spend = num(target.ad_spend) + num(a.ad_spend);
      target.ad_clicks = num(target.ad_clicks) + num(a.ad_clicks);
    } else {
      const row = {
        date: a.date,
        seller_or_vendor_id: a.seller_or_vendor_id,
        currency: a.currency,
        total_sales: 0,
        total_units: 0,
        total_units_sold: 0,
        ad_sales: num(a.ad_sales),
        ad_spend: num(a.ad_spend),
        ad_clicks: num(a.ad_clicks),
      };
      salesRows.push(row);
      firstByKey.set(key, row);
    }
  }
  return salesRows;
}

// Absolute DataDoe execution budget for THIS serverless function (Blocker 2). vercel.json pins
// maxDuration to 60s (NOT increased); the DataDoe transport gets 55s so 5s of shutdown headroom
// remains for response serialization / snapshot persistence after the last DataDoe operation.
// withDataDoeDeadline threads the deadline through AsyncLocalStorage, so EVERY DataDoe request
// (ddFetch pre-checks + an AbortController on the in-flight request), every rate-limit/429-retry
// sleep, and every poll cadence sleep inside this invocation is bounded -- no new request starts
// when insufficient time remains, and no sleep can run past the budget. No process.exit, no
// forced timers: work stops by the typed DataDoeDeadlineError surfacing through the normal path.
const ROUTE_DATADOE_BUDGET_MS = 55_000;

export default function handler(req, res) {
  return withDataDoeDeadline(Date.now() + ROUTE_DATADOE_BUDGET_MS, () => handleDataDoe(req, res));
}

// Typed-error -> HTTP mapping for the route's final catch. FIXED safe messages only (no raw
// DataDoe/Supabase text, no exportId, no marker contents). `retryable: true` is allowed ONLY
// when a DURABLE continuation exists: either the escaping deadline/poll-pending error was
// flagged durableContinuation=true by the continuation protocol (the exportId is persisted and
// a later request resumes it), or another invocation durably owns the in-progress marker.
// Without a durable continuation a retry would create a NEW export, so retryable stays false.
// Exported for the offline suite; returns null for errors this mapping does not own.
export function classifyDataDoeRouteError(err) {
  // The SINGLE source of truth for a retry hint: positive durable evidence. `retryable: true` is
  // emitted ONLY when the error object itself carries durableContinuation === true (the continuation
  // protocol sets it when the export id is persisted and a later request can resume the SAME export,
  // or when another invocation durably owns the in-progress marker). A plain object, an arbitrary
  // MANUAL_SOURCE_* code, or any error lacking that flag can never be retryable.
  const durable = err != null && err.durableContinuation === true;
  if (isDataDoeDeadlineError(err) || isDataDoePollPendingError(err)) {
    return {
      status: 504,
      body: {
        error: "DataDoe is still processing this request. Please retry in a moment.",
        retryable: durable,
      },
    };
  }
  if (isManualSourceContinuationError(err)) {
    // Only an in-progress signal WITH durable evidence invites a retry (another request owns the
    // durable marker). Everything else -- unavailable, uncertain, an unknown MANUAL_SOURCE_* code,
    // or an in-progress code without durable evidence -- is admin-safe and non-retryable.
    if (err.code === MANUAL_CONTINUATION_IN_PROGRESS && durable) {
      return { status: 504, body: { error: "Another request is already fetching this data. Please retry in a moment.", retryable: true } };
    }
    return { status: 503, body: { error: "This data fetch could not be durably tracked and needs review before retrying.", retryable: false } };
  }
  return null;
}

async function handleDataDoe(req, res) {
  let legacySharedRefresh = null;
  try {
    const access = await getDashboardAccess(req);
    const connections = getDataDoeConnections();
    const action = req.query.action;
    let publicAccountIds = String(req.query.ids || "").split(",").map((id) => id.trim()).filter(Boolean);
    let accountScope = null;
    let brandDirectoryAccounts = null;
    let discoveredDirectoryAccounts = null;

    const accountScopedAction = ACCOUNT_SCOPED_ACTIONS.has(action);
    // `sample` is admin-only diagnostics, but it still needs the same routing
    // when an administrator explicitly samples a secondary account.
    const diagnosticAccountScope = action === "sample" && publicAccountIds.length > 0;
    if (accountScopedAction || diagnosticAccountScope) {
      if (accountScopedAction && publicAccountIds.length) assertAccountAccess(access, publicAccountIds);
      accountScope = resolveDataDoeAccountIds(publicAccountIds, connections);
      // Every existing action below can continue to send DataDoe its raw IDs.
      // The public, connection-scoped ID remains available in accountScope for
      // Supabase and response metadata.
      if (accountScope) req.query.ids = accountScope.rawAccountIds.join(",");
    }
    const apiKey = accountScope?.connection.apiKey || connections[0].apiKey;
    if (action === "fields" || action === "sample") assertAdmin(access);
    // The Brand View inventory SOURCE fetch spends a DataDoe export, so it is
    // admin-only on the SERVER, not merely hidden in the UI. A non-refresh read of
    // the saved snapshot stays available to any authorised user (Supabase-only).
    if (action === "brand-inventory" && wantsRefresh(req)) assertAdmin(access);
    // The Brand Directory manual refresh spends Product Catalog exports (one per
    // eligible account), so the SOURCE-fetch path is admin-only on the SERVER. A
    // non-refresh read of the shared directory stays available to any authorised user.
    if (action === "brand-directory" && wantsRefresh(req)) assertAdmin(access);
    // A new browser may not yet have the shared account directory. Brand View
    // remains usable: on its explicit manual refresh only, discover the
    // accounts the user may access and use them to seed the brand directory.
    // Ordinary reads still never call DataDoe.
    if (action === "brand-directory" && !publicAccountIds.length && access.role !== "admin") {
      publicAccountIds = [...new Set(access.accountIds || [])];
    }
    // The browser continues a catalog sync in several small requests. Account
    // discovery belongs only to the first explicit click; repeating it for
    // every batch would waste DataDoe calls and slow the directory down.
    const continuingBrandDirectorySync = String(req.query.catalogSyncContinue || "") === "1";
    // Blocker 3: a Brand Directory SYNC (the explicit refresh AND every continuation --
    // both carry refresh=1) MUST present a valid catalogSyncActionId BEFORE any DataDoe
    // call, so the once-per-action claim can be scoped. A missing/malformed id on a fresh
    // refresh is a bad request (400); on a continuation it conflicts with the in-flight
    // action (409). Cache-only reads never enter this branch and need no action id.
    const catalogActionId = validCatalogActionId(req.query.catalogSyncActionId);
    if (action === "brand-directory" && wantsRefresh(req) && !catalogActionId) {
      res.status(continuingBrandDirectorySync ? 409 : 400).json({
        error: "A valid catalogSyncActionId is required to sync the Brand Directory. Reload the page and start the refresh again.",
      });
      return;
    }
    if (action === "brand-directory" && wantsRefresh(req) && !continuingBrandDirectorySync) {
      const discovered = await discoverConnectedAccounts(connections);
      discoveredDirectoryAccounts = discovered;
      brandDirectoryAccounts = access.role === "admin"
        ? discovered
        : discovered.filter((account) => access.accountIds.includes(String(account.id)));
      // A manual directory refresh is the explicit account-discovery action.
      // Replace a stale browser scope with every currently permitted account,
      // including newly added secondary-organisation accounts. Ordinary reads
      // remain cache-only and never call DataDoe.
      publicAccountIds = brandDirectoryAccounts.map((account) => String(account.id));
    }
    // Brand View is multi-account and therefore is not in ACCOUNT_SCOPED_ACTIONS.
    // Authorise its directory and aggregate portfolio reads before the shared
    // snapshot is served as well as before a manual refresh.
    // `brand-view-portfolio` is multi-account and can legitimately span both
    // DataDoe organisations, so it is deliberately not in ACCOUNT_SCOPED_ACTIONS
    // (that path resolves a single connection). It is authorised here instead,
    // before any read, exactly like the other portfolio actions.
    if (
      (action === "brand-directory" || action === "brand-portfolio" || action === "brand-view-portfolio")
      && publicAccountIds.length
    ) {
      assertAccountAccess(access, publicAccountIds);
    }

    if (action === "brand-portfolio") {
      const brand = String(req.query.brand || "").trim();
      const asOf = String(req.query.asOf || "");
      if (!brand || !publicAccountIds.length || !isDateStr(asOf)) {
        res.status(400).json({ error: "Brand View requires brand, one or more allowed account ids, and an asOf date (YYYY-MM-DD)." });
        return;
      }
      const accountIds = [...new Set(publicAccountIds.map(String))].sort();
      await serveSharedReport({
        res,
        refresh: wantsRefresh(req),
        reportKey: BRAND_PORTFOLIO_REPORT_KEY,
        reportVersion: BRAND_PORTFOLIO_VERSION,
        accountId: stableSelectionId("brand-portfolio", accountIds),
        params: { brand, accountIds: accountIds.join(","), asOf },
        userId: access.userId,
        label: "Brand View",
        // A portfolio build only aggregates shared snapshots plus persisted
        // Ads rows, but a larger set of mapped marketplaces may still take a
        // little longer than the default account report.
        lockSeconds: 300,
        build: () => buildBrandPortfolioSnapshot({ brand, accountIds, asOf }),
      });
      return;
    }

    /* ============================================================
       Account-scoped Brand View: Account -> Brand -> Brand Reports.

       Both actions are single-account and cache-only. Neither ever starts a
       DataDoe export, not even on an explicit Refresh: a Brand View refresh
       re-aggregates this account's already-saved Dashboard, Ads and FBA
       snapshots and saves one compact shared result. Getting *newer source*
       data is still the job of the account's own reports, which keeps DataDoe
       cost exactly where it already was.
       ============================================================ */

    if (action === "brand-view-brands") {
      if (!accountScope || accountScope.accountIds.length !== 1) {
        res.status(400).json({ error: "Brand View requires exactly one selected account." });
        return;
      }
      const accountId = accountScope.accountIds[0];
      if (!isSupabaseConfigured()) {
        res.status(200).json({
          accountId, brands: [], sources: [],
          message: "Brand View needs the shared Supabase snapshot store. This deployment has no Supabase configuration.",
        });
        return;
      }
      const { payload, savedAt, shared } = await brandViewDirectory(accountId, { rebuild: wantsRefresh(req) });
      res.status(200).json({
        ...payload,
        reportKey: BRAND_VIEW_BRANDS_REPORT_KEY,
        reportVersion: BRAND_VIEW_BRANDS_VERSION,
        snapshot: { savedAt, shared },
      });
      return;
    }

    if (action === "brand-view") {
      if (!accountScope || accountScope.accountIds.length !== 1) {
        res.status(400).json({ error: "Brand View requires exactly one selected account." });
        return;
      }
      const accountId = accountScope.accountIds[0];
      const brand = String(req.query.brand || "").trim();
      const asOf = String(req.query.asOf || "");
      if (!brand) {
        res.status(400).json({ error: "Brand View requires a selected brand." });
        return;
      }
      if (!isDateStr(asOf)) {
        res.status(400).json({ error: "Brand View requires an asOf date (YYYY-MM-DD)." });
        return;
      }
      // The brand must be one this account's own saved data records. This is the
      // server-side guarantee behind "the Brand dropdown must never contain
      // brands from another account": a crafted request naming another
      // account's brand is refused rather than silently returning nothing.
      // Cache-first, then one rebuild only if the brand is not in the saved
      // list. That covers a brand added since the directory was last derived
      // without paying for a rebuild on the common path.
      let { payload: directory } = await brandViewDirectory(accountId);
      if (!directory.brands.includes(brand)) {
        ({ payload: directory } = await brandViewDirectory(accountId, { rebuild: true }));
      }
      if (!directory.brands.includes(brand)) {
        res.status(400).json({
          error: directory.brands.length
            ? `"${brand}" is not a brand recorded in this account's saved data. Choose a brand from this account.`
            : directory.message,
        });
        return;
      }

      const accountMeta = await sharedAccountMetadata(accountId);
      await serveSharedReport({
        res,
        refresh: wantsRefresh(req),
        reportKey: BRAND_VIEW_REPORT_KEY,
        reportVersion: BRAND_VIEW_VERSION,
        // The brand is part of the snapshot's account key, not only its params
        // hash, so the across-midnight stale-scope fallback can never serve one
        // brand's saved report for another brand.
        accountId: brandViewScopeId(accountId, brand),
        params: { accountId, brand, asOf },
        userId: access.userId,
        label: "Brand View",
        build: () => buildBrandViewSnapshot({
          accountId,
          brand,
          asOf,
          account: accountMeta,
          getSnapshot: getLatestReportSnapshotHydrated,
          getAdsRows: getAdsDailySourceRows,
        }),
      });
      return;
    }

    // The cross-account Brand View: one brand across every account it is mapped
    // to. Same builder pieces, same payload shape and same client code as the
    // single-account report above; only the account set differs. Still cache-only:
    // it aggregates saved snapshots and never starts a DataDoe export.
    if (action === "brand-view-portfolio") {
      const brand = String(req.query.brand || "").trim();
      const asOf = String(req.query.asOf || "");
      const accountIds = [...new Set(publicAccountIds.map(String))].sort();
      if (!brand || !accountIds.length || !isDateStr(asOf)) {
        res.status(400).json({ error: "Brand View requires a brand, one or more allowed account ids, and an asOf date (YYYY-MM-DD)." });
        return;
      }
      // Authorised above for this action, but assert again next to the read so
      // the guarantee is visible at the point of use.
      assertAccountAccess(access, accountIds);

      const directory = await getLatestReportSnapshot({
        reportKey: "account-directory",
        accountId: "__account-directory__",
      }).catch(() => null);
      const accountsById = Object.fromEntries(
        (directory?.payload?.accounts || [])
          .filter((entry) => accountIds.includes(String(entry.id)))
          .map((entry) => [String(entry.id), { name: entry.name || null, country: entry.country || null }])
      );

      // Brand-sales is read STORAGE-FIRST so a large (out-of-line) payload never drops its country, and the same
      // build is the read-path self-heal: when the selected brand's account set changes (the directory just
      // freshened), the new-identity snapshot is missing, so it is re-derived from durable evidence (brand-sales +
      // durable ASIN Ads + saved inventory) ZERO-export -- no manual Refresh, and never a snapshot for a different
      // account set (the set is baked into the report identity).
      const buildPortfolio = () => buildBrandViewPortfolioSnapshot({
        accountIds,
        brand,
        asOf,
        accountsById,
        getSnapshot: getLatestReportSnapshotHydrated,
        getAdsRows: getAdsDailySourceRows,
      });
      await serveSharedReport({
        res,
        refresh: wantsRefresh(req),
        reportKey: BRAND_VIEW_PORTFOLIO_REPORT_KEY,
        reportVersion: BRAND_VIEW_PORTFOLIO_VERSION,
        accountId: brandViewPortfolioScopeId(accountIds, brand),
        params: { accountIds: accountIds.join(","), brand, asOf },
        userId: access.userId,
        label: "Brand View",
        // Reading a dozen saved Dashboard payloads sequentially takes longer
        // than a single-account build, so the lock is held for longer.
        lockSeconds: 300,
        build: buildPortfolio,
        deriveDurable: async () => ({ payload: await buildPortfolio() }),
      });
      return;
    }

    // Exchange rates for the Brand View currency selector. Reading is always
    // Supabase-first; the provider is contacted server-side at most once per
    // provider cycle. A browser never calls the FX provider directly.
    if (action === "fx-rates") {
      const rates = await getFxRates();
      res.status(200).json({ ...rates, displayCurrencies: FX_DISPLAY_CURRENCIES });
      return;
    }

    const legacyShared = legacySharedDescriptor({ action, req, access, publicAccountIds, accountScope });
    if (legacyShared) {
      const sharedOptions = {
        res,
        ...legacyShared,
        userId: access.userId,
      };
      // Daily Reporting self-heals on a READ: if no daily-reporting-shared-v2 snapshot exists yet, recompute it
      // from durable evidence (OLI history + ASIN Ads + the reusable Product Catalog snapshot) through the REAL
      // derivation contract and publish it -- ZERO DataDoe. This closes the rollout-order gap where the frontend
      // requests v2 before any v2 snapshot was published, WITHOUT ever spending a token on a page visit.
      if (action === "daily" && accountScope && accountScope.accountIds.length === 1) {
        const dailyPrimary = connections.find((c) => c && c.id === "primary" && String(c.apiKey || "").trim());
        if (dailyPrimary) {
          const dailyOrgFingerprint = dailyPrimary.organizationFingerprint || organizationFingerprint(dailyPrimary.apiKey);
          const dailyAccountId = accountScope.accountIds[0];
          const dailyRawSellerId = (accountScope.rawAccountIds && accountScope.rawAccountIds[0]) || dailyAccountId;
          const dailyDurableReaders = {
            readOliHistory: getSourceOliHistoryRows,
            readOliCoverage: getSourceCoverageWindows,
            readAsinAds: getAsinAdsDailyRows,
            readAdsCoverage: getDailyAdsCoverage,
            readCatalogSnapshot: getSourceSnapshot,
            loadCatalogPayload: getSourceSnapshotPayload,
          };
          sharedOptions.deriveDurable = async () => {
            const meta = await accountDirectoryMeta(dailyAccountId).catch(() => null);
            return rederiveDailyV2({
              accountId: dailyAccountId, rawSellerId: dailyRawSellerId, currency: meta ? meta.currency : null,
              from: legacyShared.params.from, to: legacyShared.params.to, brand: legacyShared.params.brand || "ALL",
              organizationFingerprint: dailyOrgFingerprint,
            }, dailyDurableReaders);
          };
        }
      }
      if (!wantsRefresh(req)) {
        // Brand Directory READ: a generic ZERO-EXPORT self-heal. The stored map is served immediately when its
        // membership fingerprint still matches the live brand-sales evidence; otherwise it is rebuilt from the
        // latest validated brand-sales (storage-first) under the shared lock -- so a new scheduler brand-sales
        // publication is picked up automatically without a manual refresh, page reload, or DataDoe export.
        if (action === "brand-directory") {
          await serveSelfHealingBrandDirectory({ res, accountIds: publicAccountIds, legacyShared, brandDirectoryAccounts });
          return;
        }
        // Reading a report is always server-side and shared. It never reaches
        // DataDoe, even on a new browser or under a different user account.
        await serveSharedReport({ ...sharedOptions, refresh: false });
        return;
      }
      legacySharedRefresh = await beginSharedRefresh(sharedOptions);
      if (!legacySharedRefresh) return;
      if (action === "brand-directory" && discoveredDirectoryAccounts) {
        await persistAccountDirectory(discoveredDirectoryAccounts);
      }
    }
    const sendLegacyPayload = async (payload) => {
      if (legacySharedRefresh) {
        await legacySharedRefresh.finish(payload);
        return;
      }
      res.status(200).json(payload);
    };

    if (action === "accounts") {
      const accounts = await discoverConnectedAccounts(connections);
      await sendLegacyPayload({ accounts });
      return;
    }

    // Brand View needs a global picker before a user has selected an account.
    // This is deliberately a manual, catalog-only request: it avoids the old
    // 14-month order-history scan merely to populate a dropdown. Requested
    // public IDs are authorized and resolved one at a time so the resulting
    // brand-to-account map is exact across both DataDoe connections.
    if (action === "brand-directory") {
      if (!publicAccountIds.length) {
        res.status(400).json({ error: "Brand directory requires at least one accessible account." });
        return;
      }
      assertAccountAccess(access, publicAccountIds);
      // One durable id correlates every request of ONE explicit action; it scopes the
      // atomic once-per-action claim, the durable attempt markers and the cumulative
      // this-action failure summary. It was validated (safe token shape, required for a
      // sync) BEFORE any DataDoe call above; a cache-only read leaves it null.
      const actionId = catalogActionId;
      let remainingAccountIds = [];
      let attempted = 0;
      let catalogSyncStatus = null; // manifest status surfaced to the browser
      let catalogSyncCode = null;   // typed admin-safe operational-failure code (never raw)

      // The explicit directory refresh is driven by a durable SERVER-OWNED action manifest
      // (keyed by actionId), NOT the browser cursor. A first click builds the queue from
      // THIS action's fresh discovery; a continuation loads the manifest and advances it by
      // EXACTLY ONE account (one export maximum). The browser cursor is only a consistency
      // check; anything that does not match the manifest (unknown/changed action, wrong
      // admin, changed scope, injected/removed/reordered/duplicated cursor) is a plain 409
      // BEFORE any DataDoe call. Page load / normal reads never enter this branch.
      if (wantsRefresh(req)) {
        const carriedCursor = String(req.query.catalogSyncAccountIds || "").split(",").map((s) => s.trim()).filter(Boolean);
        const authorizedPrimaryIds = [...new Set(publicAccountIds.map(String))].filter(isPrimaryCatalogAccount);
        // The eligible queue is derived from fresh discovery on the FIRST click only; a
        // continuation lets the manifest own the queue (directory not needed there).
        const creationDirectory = continuingBrandDirectorySync
          ? {}
          : await sharedSnapshotBrandAccounts(publicAccountIds, { actionId });
        const orchestrated = await orchestrateBrandCatalogAction({
          actionId,
          userId: access.userId || null,
          isContinuation: continuingBrandDirectorySync,
          clientCursor: carriedCursor,
          authorizedPrimaryIds,
          directory: creationDirectory,
          connections,
        });
        if (orchestrated.conflict) {
          // Admin-safe 409: the request does not match the server-owned action. No DataDoe
          // export was created. (legacySharedRefresh's lock is released in the finally.)
          res.status(409).json({
            error: "This Brand Directory sync request is no longer valid (its action was not found, changed, or its account scope or queue did not match). Reload the page and start the refresh again.",
            code: orchestrated.code,
          });
          return;
        }
        attempted = orchestrated.attempted;
        remainingAccountIds = orchestrated.remaining;
        catalogSyncStatus = orchestrated.status;
        catalogSyncCode = orchestrated.operationalCode;
        // Best-effort retention of OLD manifest/attempt rows, ONCE per action (first click
        // only). Never fails the refresh, never touches active actions, LKG catalog
        // snapshots or the account directory.
        if (!continuingBrandDirectorySync) await pruneBrandCatalogActionRecords().catch(() => {});
      }

      // Read the directory for the response over the authorized scope (brand map + typed
      // cumulative summary). This is Supabase-only and never calls DataDoe.
      const directory = await sharedSnapshotBrandAccounts(publicAccountIds, { actionId });
      const saved = serialiseBrandAccountMembership(directory.membership, directory.selectorEntries);
      // Typed, admin-safe cumulative summary, derived from the persisted snapshots so no
      // failure is lost across continuation batches. It unions: accounts with no usable
      // saved catalog (catalogUnavailable) AND accounts whose complete brand map is a
      // preserved LKG but whose latest attempt THIS action failed (catalogActionFailures).
      // Only typed safe codes are included -- never a raw DataDoe body/source id/URL.
      const unavailableByAccount = new Map();
      for (const [id, code] of directory.catalogUnavailable) unavailableByAccount.set(id, { code, preservedLkg: false });
      for (const [id, code] of directory.catalogActionFailures) if (!unavailableByAccount.has(id)) unavailableByAccount.set(id, { code, preservedLkg: true });
      const catalogUnavailableAccounts = [...unavailableByAccount.entries()].map(([accountId, { code, preservedLkg }]) => {
        const account = (brandDirectoryAccounts || []).find((entry) => String(entry.id) === String(accountId));
        return { accountId, name: account?.name || accountId, code, preservedLkg };
      });
      const unavailableByCode = {};
      for (const { code } of catalogUnavailableAccounts) unavailableByCode[code] = (unavailableByCode[code] || 0) + 1;

      const operationalFailure = catalogSyncStatus === "operational-failure";
      await sendLegacyPayload({
        ...saved,
        // The membership PROVENANCE fingerprint of the brand-sales evidence this map was built from. The read
        // path compares it against the live fingerprint to self-heal the directory with ZERO DataDoe.
        membershipFingerprint: directory.fingerprint,
        accounts: brandDirectoryAccounts || [],
        source: attempted ? "shared-snapshots-and-catalog-sync" : "shared-snapshots",
        // A stopped action is not "more work to poll" -- the browser should stop, not spin.
        partial: !operationalFailure && remainingAccountIds.length > 0,
        catalogUnavailableAccounts,
        catalogUnavailable: {
          total: catalogUnavailableAccounts.length,
          byCode: unavailableByCode,
          preservedLkg: catalogUnavailableAccounts.filter((entry) => entry.preservedLkg).length,
        },
        catalogSync: {
          attempted,
          remainingAccountIds,
          // The AUTHORITATIVE server-owned action status. "operational-failure" is a typed,
          // admin-safe stop (no raw DataDoe/Supabase error); the browser must not auto-retry.
          status: catalogSyncStatus,
          code: catalogSyncCode,
        },
        message: operationalFailure
          ? "The Brand Directory sync could not be recorded safely and was stopped before completing. No duplicate export was created; start the refresh again to continue."
          : (saved.brands.length
            ? null
            : "No brand data is saved yet. The explicit directory sync is loading Product Catalog data account by account; keep this page open until it completes."),
      });
      return;
    }

    if (action === "sales") {
      const { ids, from, to } = req.query;
      if (!ids || !from || !to) {
        res.status(400).json({ error: "Missing required params: ids, from, to" });
        return;
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean);
      const rows = await fetchExportRows(apiKey, DASHBOARD_SOURCE_ID, DASHBOARD_COLUMNS, sellerOrVendorIds, from, to, DASHBOARD_ROW_LIMIT);
      await sendLegacyPayload({ rows });
      return;
    }

    // Brand-aware dashboard data for one selected account. Order Line Items
    // is rolled up by date + ASIN, then joined to the catalog's product_brand
    // field server-side. This keeps headline sales aligned to Seller Central's
    // Order Report while retaining the existing brand filter.
    if (action === "brand-sales") {
      const { ids, from, to } = req.query;
      if (!ids || !from || !to) {
        res.status(400).json({ error: "Missing required params: ids, from, to" });
        return;
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean);
      if (sellerOrVendorIds.length !== 1) {
        res.status(400).json({ error: "Dashboard refresh requires exactly one selected account." });
        return;
      }
      // Single implementation, shared with the scheduled-sync adapter.
      const payload = await buildBrandSalesPayload({ apiKey, ids: sellerOrVendorIds, from, to });
      await sendLegacyPayload(payload);
      return;
    }

    // Compact FBA inventory for Brand View. A non-refresh read was already served
    // above from the saved snapshot (Supabase-only, zero DataDoe). A refresh is
    // admin-gated above and creates at most ONE FBA Inventory Health export; it
    // reuses the Product Catalog source cache from the preceding brand-sales
    // refresh (or the saved brand-sales asinBrand map) instead of a duplicate
    // catalog export. Truncated/failed source is refused so a good snapshot survives.
    if (action === "brand-inventory") {
      if (!accountScope || accountScope.accountIds.length !== 1) {
        res.status(400).json({ error: "Brand View inventory requires exactly one selected account." });
        return;
      }
      const publicAccountId = accountScope.accountIds[0];
      const to = String(req.query.to || "");
      if (!isDateStr(to)) {
        res.status(400).json({ error: "Brand View inventory requires an asOf date (to=YYYY-MM-DD)." });
        return;
      }
      // PRIMARY-ONLY: a legacy dd-secondary mapping is skipped, never stripped and
      // routed through the primary DataDoe key (the secondary key was removed).
      if (String(publicAccountId).startsWith("dd-secondary:") || accountScope.connection?.id !== "primary" || !apiKey) {
        res.status(409).json({
          error: "This account is still mapped to the legacy Secondary DataDoe organization, which is no longer connected. Move it to the primary organization, then reload the account and brand directories.",
        });
        return;
      }
      const sellerOrVendorIds = accountScope.rawAccountIds;
      // Best-effort account country for the rare inventory row that omits a
      // marketplace code. A directory miss is non-fatal (the rows carry it).
      const inventoryDirectory = await getLatestReportSnapshot({ reportKey: "account-directory", accountId: "__account-directory__" }).catch(() => null);
      const accountCountry = (inventoryDirectory?.payload?.accounts || []).find((entry) => String(entry.id) === publicAccountId)?.country || null;

      // The EXACT expected inventory window the fold validates every row against.
      const inventoryFrom = addDaysStr(to, -PLAN_INVENTORY_LOOKBACK_DAYS);
      let payload;
      try {
        // No live Product Catalog fallback: brand-inventory uses ONLY the saved
        // brand-sales asinBrand map. A missing map fails BEFORE the FBA export, so a
        // just-failed Brand Sales catalog can never cause a second Catalog export.
        ({ payload } = await buildBrandInventorySnapshot({
          accountId: publicAccountId,
          accountCountry,
          from: inventoryFrom,
          to,
          rowLimit: PLAN_INVENTORY_ROW_LIMIT,
          getSnapshot: getLatestReportSnapshotHydrated,
          fetchInventoryRows: () => fetchExportRows(
            apiKey, FBA_HEALTH_SOURCE_ID, FBA_HEALTH_COLUMNS, sellerOrVendorIds,
            inventoryFrom, to, PLAN_INVENTORY_ROW_LIMIT,
            { orderByColumn: "date", orderByDirection: "DESC" }
          ),
        }));
      } catch (buildError) {
        // Never surface a raw DataDoe/Supabase body. A validated refusal (missing brand
        // map, truncation, invalid row) is already an admin-safe message; anything else
        // becomes a generic operational message so the browser only learns the account
        // failed, not the upstream detail.
        if (buildError && buildError.brandInventorySafe) throw buildError;
        throw new Error("FBA inventory could not be refreshed from DataDoe for this account. The previous saved inventory snapshot is preserved.");
      }
      await sendLegacyPayload(payload);
      return;
    }

    // Daily Reporting data. All brands stay compact at account/date grain;
    // a named brand is joined through the catalog at ASIN/day grain first.
    if (action === "daily") {
      const { ids, from, to } = req.query;
      const brand = String(req.query.brand || "ALL");
      if (!ids || !from || !to) {
        res.status(400).json({ error: "Missing required params: ids, from, to" });
        return;
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean);
      if (sellerOrVendorIds.length !== 1) {
        res.status(400).json({ error: "Daily Reporting requires exactly one selected account." });
        return;
      }

      if (brand !== "ALL") {
        const salesRaw = await fetchDailyBrandSalesRows(apiKey, sellerOrVendorIds, from, to);
        const catalog = await fetchExportRows(
          apiKey,
          PRODUCT_CATALOG_SOURCE_ID,
          PRODUCT_CATALOG_COLUMNS,
          sellerOrVendorIds,
          from,
          to,
          CATALOG_ROW_LIMIT,
          { orderByColumn: "child_asin" }
        );
        // Advertising data is account-level in the current source. Omitting it
        // is safer than presenting the whole account's spend as one brand's.
        await sendLegacyPayload({ rows: dailyRowsForBrand(salesRaw, catalog, brand), brandFiltered: true });
        return;
      }

      // Blocker 1: derive all-brand from the SAME canonical Order Line Items superset the named-brand path
      // fetches (no separate compact all-brand export). rollupSupersetToDaily folds the ASIN-level superset
      // to one row per (date, seller, currency) exactly like the scheduler's dailyReportingPayload ALL
      // branch, so the live route == the scheduler for BOTH modes.
      const salesRaw = await fetchDailyBrandSalesRows(apiKey, sellerOrVendorIds, from, to);
      const rows = normalizeDailySalesRows(rollupSupersetToDaily(salesRaw));
      for (const r of rows) r.total_units_sold = r.total_units;
      // The scheduled Ads worker owns the durable ASIN Ads dataset (asin-performance-v1, the SINGLE reusable
      // advertising source Daily shares with Brand View). Reading its saved rows avoids another DataDoe export
      // whenever a user opens or refreshes Daily Reporting. The shared aggregation folds every ASIN into per-
      // (date, currency) totals (ad_sales_same_sku -> ad_sales; no campaign halo), stamped with the same seller
      // key the campaign path used so mergeSalesAndAds behaves identically. Keep a REST fallback until the first
      // scheduled seed has completed for an existing deployment.
      let ads;
      if (isSupabaseConfigured()) {
        const asinRows = await getAsinAdsDailyRows(accountScope.accountIds[0], from, to);
        ads = normalizeAdRows(aggregateAsinAdsDailyRows(asinRows, { rawSellerId: accountScope.accountIds[0] }));
      } else {
        const adRaw = await fetchExportRows(
          apiKey,
          ADS_SOURCE_ID,
          ADS_COLUMNS,
          sellerOrVendorIds,
          from,
          to,
          DAILY_ROW_LIMIT,
          { groupBy: ADS_GROUP_BY, aggregations: ADS_AGGREGATIONS }
        );
        ads = normalizeAdRows(adRaw);
      }
      mergeSalesAndAds(rows, ads);
      await sendLegacyPayload({ rows, brandFiltered: false });
      return;
    }

    // Reconciliation is deliberately fetched as six monthly, order-level
    // batches. The UI joins the two sources locally by amazon_order_id and
    // exposes settlement posting dates separately from purchase dates.
    if (action === "reconciliation") {
      const { ids, from, to } = req.query;
      if (!ids || !from || !to) {
        res.status(400).json({ error: "Missing required params: ids, from, to" });
        return;
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean);
      if (sellerOrVendorIds.length !== 1) {
        res.status(400).json({ error: "Reconciliation requires exactly one selected account." });
        return;
      }
      const start = String(from), end = String(to);
      const windows = splitDateRangeByMonth(start, end);
      if (windows.length !== 6 || windows.some((window) => !isFullCalendarMonthWindow(window))) {
        res.status(400).json({ error: "Reconciliation requires exactly six complete calendar months." });
        return;
      }
      const orderRows = await reconciliationRowsByMonth(
        apiKey, ORDER_LINE_ITEMS_SOURCE_ID, RECONCILIATION_ORDER_COLUMNS, sellerOrVendorIds,
        start, end, RECONCILIATION_ORDER_AGGREGATIONS, RECONCILIATION_ORDER_GROUP_BY
      );
      const settlementRows = await reconciliationRowsByMonth(
        apiKey, RECONCILIATION_SETTLEMENTS_SOURCE_ID, RECONCILIATION_SETTLEMENT_COLUMNS, sellerOrVendorIds,
        start, end, RECONCILIATION_SETTLEMENT_AGGREGATIONS, RECONCILIATION_SETTLEMENT_GROUP_BY
      );
      const catalog = await fetchExportRows(
        apiKey, PRODUCT_CATALOG_SOURCE_ID, PRODUCT_CATALOG_COLUMNS, sellerOrVendorIds, start, end, CATALOG_ROW_LIMIT,
        { orderByColumn: "child_asin" }
      );
      await sendLegacyPayload({
        from: start,
        to: end,
        months: windows.map((w) => w.from.slice(0, 7)),
        orders: reconciliationOrders(orderRows, catalog),
        settlements: reconciliationSettlements(settlementRows),
      });
      return;
    }

    // SKU P&L Analyzer: one selected account only, exactly six complete
    // calendar months. Uses the Premium "Profit by SKU & Date" source, fetched
    // in monthly batches and folded to one row per (currency|sku|child_asin)
    // with per-month sums. The browser localises to a single currency, applies
    // the shared brand scope, switches month, and recomputes every ratio.
    if (action === "sku-pl") {
      const { ids, from, to } = req.query;
      if (!ids || !from || !to) {
        res.status(400).json({ error: "Missing required params: ids, from, to" });
        return;
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean);
      if (sellerOrVendorIds.length !== 1) {
        res.status(400).json({ error: "SKU P&L Analyzer requires exactly one selected account." });
        return;
      }
      const start = String(from), end = String(to);
      const windows = splitDateRangeByMonth(start, end);
      if (windows.length !== 6 || windows.some((window) => !isFullCalendarMonthWindow(window))) {
        res.status(400).json({ error: "SKU P&L Analyzer requires exactly six complete calendar months." });
        return;
      }
      const rows = await fetchSkuPlRows(apiKey, sellerOrVendorIds, windows);
      const currencies = [...new Set(rows.map((r) => r.currency).filter(Boolean))].sort();
      const catalogBrands = [...new Set(rows.map((r) => r.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      await sendLegacyPayload({
        accountId: accountScope.accountIds[0],
        from: start,
        to: end,
        months: windows.map((w) => w.from.slice(0, 7)),
        currencies,
        catalogBrands,
        rows,
      });
      return;
    }

    // Keyword Rank & Share Tracker: fetch the selected account's weekly SQP
    // series. The client derives money keywords and every share/trend locally,
    // so brand/ASIN/search/status filters never make another DataDoe request.
    // New SQP connections commonly have only four weekly periods. When fewer
    // than four arrive, use the longer monthly source; only report a baseline
    // when neither cadence has two comparable periods.
    if (action === "keyword-rank") {
      const { ids, to } = req.query;
      if (!ids || !to) {
        res.status(400).json({ error: "Missing required params: ids, to" });
        return;
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean);
      if (sellerOrVendorIds.length !== 1) {
        res.status(400).json({ error: "Keyword Rank requires exactly one selected account." });
        return;
      }
      const end = String(to);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) {
        res.status(400).json({ error: "Invalid to date. Use YYYY-MM-DD." });
        return;
      }

      let weeklyRows;
      try {
        weeklyRows = await fetchSqpRows(
          apiKey, SQP_WEEKLY_SOURCE_ID, sellerOrVendorIds,
          addDaysStr(end, -SQP_WEEKLY_LOOKBACK_DAYS), end
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/source is disabled for this organization/i.test(message)) {
          res.status(424).json({ error: "Keyword Rank is disabled in DataDoe. In DataDoe, open Settings > Data tables and enable Search Query Performance (SQP) by ASIN (Weekly), then refresh this report again." });
          return;
        }
        throw err;
      }

      const weeklyPeriods = sqpDistinctPeriods(weeklyRows);
      let cadence = "weekly";
      let rows = weeklyRows;
      let periods = weeklyPeriods;
      if (weeklyPeriods.length < 4) {
        let monthlyRows;
        try {
          monthlyRows = await fetchSqpRows(
            apiKey, SQP_MONTHLY_SOURCE_ID, sellerOrVendorIds,
            addDaysStr(end, -SQP_MONTHLY_LOOKBACK_DAYS), end
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/source is disabled for this organization/i.test(message)) {
            res.status(424).json({ error: "Keyword Rank needs more SQP history, but the monthly SQP fallback is disabled in DataDoe. In DataDoe, open Settings > Data tables and enable Search Query Performance (SQP) by ASIN (Monthly), then refresh this report again." });
            return;
          }
          throw err;
        }
        const monthlyPeriods = sqpDistinctPeriods(monthlyRows);
        if (monthlyPeriods.length >= 2) {
          cadence = "monthly";
          rows = monthlyRows;
          periods = monthlyPeriods;
        } else {
          cadence = "baseline";
          // Prefer the fresher weekly observation; when it is empty use the
          // monthly row so the user still gets an honest current baseline.
          rows = weeklyRows.length ? weeklyRows : monthlyRows;
          periods = sqpDistinctPeriods(rows);
        }
      }

      const catalogRows = await fetchExportRows(
        apiKey, PRODUCT_CATALOG_SOURCE_ID, PRODUCT_CATALOG_COLUMNS, sellerOrVendorIds,
        addDaysStr(end, -365), end, CATALOG_ROW_LIMIT,
        { orderByColumn: "child_asin", orderByDirection: "ASC" }
      );
      const products = [];
      const seenAsins = new Set();
      for (const row of catalogRows) {
        const asin = String(row.child_asin || "").trim();
        if (!asin || seenAsins.has(asin)) continue;
        seenAsins.add(asin);
        products.push({
          asin,
          name: String(row.product_name || "").trim() || null,
          brand: String(row.product_brand || "").trim() || "Unassigned",
        });
      }

      await sendLegacyPayload({
        accountId: accountScope.accountIds[0],
        cadence,
        periods,
        weeklyPeriodCount: weeklyPeriods.length,
        rows,
        products,
        catalogBrands: catalogBrandNames(catalogRows),
        retrievedAt: new Date().toISOString(),
      });
      return;
    }

    // Content Change Alerts: one selected account only. Amazon sends these
    // near-real-time A+ / branded-item notifications without a stable payload
    // schema, so the server extracts ASINs and resolves them through the
    // existing Product Catalog before returning a compact event summary.
    if (action === "content-changes") {
      const { ids, asOf } = req.query;
      if (!ids) {
        res.status(400).json({ error: "Missing required param: ids" });
        return;
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean);
      if (sellerOrVendorIds.length !== 1) {
        res.status(400).json({ error: "Content Change Alerts requires exactly one selected account." });
        return;
      }
      const catalogTo = /^\d{4}-\d{2}-\d{2}$/.test(String(asOf || "")) ? String(asOf) : new Date().toISOString().slice(0, 10);
      const catalogFrom = addDaysStr(catalogTo, -365);
      let notificationRows;
      try {
        notificationRows = await fetchExportRows(
          apiKey, CONTENT_CHANGE_SOURCE_ID, CONTENT_CHANGE_COLUMNS, sellerOrVendorIds,
          null, null, CONTENT_CHANGE_ROW_LIMIT,
          { orderByColumn: "event_time", orderByDirection: "DESC" }
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/source is disabled for this organization/i.test(message)) {
          res.status(424).json({ error: "Content Change Alerts is disabled in DataDoe. In DataDoe, open Settings > Data tables and enable Branded Item Content Change Notifications, then refresh this report again." });
          return;
        }
        throw err;
      }
      const catalogRows = await fetchExportRows(
        apiKey, PRODUCT_CATALOG_SOURCE_ID, PRODUCT_CATALOG_COLUMNS, sellerOrVendorIds,
        catalogFrom, catalogTo, CATALOG_ROW_LIMIT,
        { orderByColumn: "child_asin", orderByDirection: "ASC" }
      );
      const events = compactContentChangeEvents(notificationRows, catalogRows);
      await sendLegacyPayload({
        accountId: accountScope.accountIds[0],
        events,
        catalogBrands: catalogBrandNames(catalogRows),
        retrievedAt: new Date().toISOString(),
        unassignedEvents: events.filter((event) => !event.brands.length).length,
      });
      return;
    }

    // FBA Shipment Plan: one selected account only. Combines per-ASIN unit
    // velocity (3 completed months + current-month MTD) with the latest FBA
    // inventory-health snapshot and (US only) AWD available inventory. All
    // derived planning metrics are computed in the browser so filter/target
    // changes never trigger a DataDoe request.
    if (action === "fba-plan") {
      const { ids, to } = req.query;
      if (!ids || !to) {
        res.status(400).json({ error: "Missing required params: ids, to" });
        return;
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean);
      if (sellerOrVendorIds.length !== 1) {
        res.status(400).json({ error: "FBA Shipment Plan requires exactly one selected account." });
        return;
      }
      const { completed, current } = planMonthWindows(String(to));

      // Authoritative account country (drives US-only AWD logic).
      const accounts = await fetchAccountsRaw(apiKey);
      const account = accounts.find((a) => a.id === sellerOrVendorIds[0]) || null;
      const isUS = String(account?.country || "").toUpperCase() === "US";

      // 1) ONE canonical Order Line Items sales fragment over [completed[0].from .. asOf] (Blocker 1).
      // Per-ASIN ordered units per month AND the current-month latest sales date are DERIVED from this
      // single shared fragment (byte-identical spec to the other OLI reports, so overlapping calendar
      // slices reuse one export). Units are a currency-agnostic count, so this sums total_units_sum
      // ACROSS currencies (the canonical rows still carry currency for the money-keyed reports).
      // Blocker 1: slice by canonicalOliSlices so the fba fragment's interior + asOf-boundary slices are
      // byte-identical in request identity to the scheduler + daily + the other OLI reports (one export,
      // many owners). Per-slice strict cap: a slice at the row cap is indistinguishable from a truncated
      // one, so it is rejected BEFORE appending (an understated velocity would misplan shipments).
      const oliSalesRows = [];
      for (const slice of canonicalOliSlices(completed[0].from, current.to)) {
        const sliceRows = await fetchExportRows(
          apiKey, PLAN_SALES_SOURCE_ID, OLI_SALES_COLUMNS, sellerOrVendorIds, slice.from, slice.to, OLI_SALES_ROW_LIMIT,
          { groupBy: OLI_SALES_GROUP_BY, aggregations: OLI_SALES_AGGREGATIONS, orderByColumn: "date", orderByDirection: "ASC" }
        );
        if (sliceRows.length >= OLI_SALES_ROW_LIMIT) {
          throw new Error(`FBA Shipment Plan sales export reached the ${OLI_SALES_ROW_LIMIT.toLocaleString("en-US")} row cap for ${slice.from} to ${slice.to}. The report was not saved because a partial slice would understate demand velocity.`);
        }
        oliSalesRows.push(...sliceRows);
      }
      const asinSet = new Set();
      const unitsByAsinByMonth = {}; // asin -> { monthKey: units }
      const mtdByAsin = new Map();   // asin -> current-month units
      const unitsByDate = new Map(); // current-month date -> summed units (latest-date probe)
      const completedMonthKeys = new Set(completed.map((m) => m.key));
      for (const r of oliSalesRows) {
        const date = String(r.date || "");
        const mk = date.slice(0, 7);
        const asin = String(r.child_asin || "").trim();
        const units = num(r.total_units_sum ?? r.quantity);
        if (asin && (mk === current.key || completedMonthKeys.has(mk))) {
          asinSet.add(asin);
          const byMonth = unitsByAsinByMonth[asin] || (unitsByAsinByMonth[asin] = {});
          byMonth[mk] = (byMonth[mk] || 0) + units;
          if (mk === current.key) mtdByAsin.set(asin, (mtdByAsin.get(asin) || 0) + units);
        }
        if (mk === current.key && date) unitsByDate.set(date, (unitsByDate.get(date) || 0) + units);
      }
      // 2b) Latest current-month date whose summed units > 0. Elapsed days are measured to this date so
      // the MTD projection is not diluted by dates the source has not populated yet.
      let salesLatestDate = null;
      for (const [date, units] of unitsByDate) {
        if (units > 0 && (!salesLatestDate || date > salesLatestDate)) salesLatestDate = date;
      }
      // Elapsed days = day-of-month of the latest completed sales date, so the
      // MTD projection uses the true covered days rather than the raw calendar
      // day (the sales source can lag a few days).
      const elapsedDays = (salesLatestDate && salesLatestDate >= current.from && salesLatestDate <= current.to)
        ? Number(salesLatestDate.slice(8, 10))
        : 0;

      // 3) Catalog brand + product name. Use the full 3-month + MTD window so a
      // product released before the current month is still resolved to a brand.
      const catalog = await fetchExportRows(
        apiKey, PRODUCT_CATALOG_SOURCE_ID, PRODUCT_CATALOG_COLUMNS, sellerOrVendorIds, completed[0].from, current.to, CATALOG_ROW_LIMIT,
        { orderByColumn: "child_asin" }
      );
      const brandByAsin = new Map();
      const nameByAsin = new Map();
      for (const c of catalog) {
        const asin = String(c.child_asin || "").trim();
        if (!asin) continue;
        const brand = String(c.product_brand || "").trim();
        if (brand && !brandByAsin.has(asin)) brandByAsin.set(asin, brand);
        const name = String(c.product_name || "").trim();
        if (name && !nameByAsin.has(asin)) nameByAsin.set(asin, name);
      }

      // 4) Latest FBA inventory-health snapshot, folded from SKU to ASIN.
      const invRows = await fetchExportRows(
        apiKey, FBA_HEALTH_SOURCE_ID, FBA_HEALTH_COLUMNS, sellerOrVendorIds,
        addDaysStr(String(to), -PLAN_INVENTORY_LOOKBACK_DAYS), String(to), PLAN_INVENTORY_ROW_LIMIT,
        { orderByColumn: "date", orderByDirection: "DESC" }
      );
      let inventoryDate = null;
      for (const r of invRows) {
        if (r.date && (!inventoryDate || r.date > inventoryDate)) inventoryDate = r.date;
      }
      const invByAsin = {};
      const skusByAsin = {};
      const invProductName = new Map();
      // ADDITIVE ONLY. FBA Inventory Health is per marketplace, but the per-ASIN
      // rows below intentionally fold that dimension away for the shipment plan.
      // The account-scoped Brand View needs FBA inventory per country, so the
      // same rows are also folded to (marketplace, brand) here. Nothing existing
      // reads this key, so the FBA Shipment Plan report is unchanged.
      const invByCountryBrand = new Map();
      for (const r of invRows) {
        if (inventoryDate && r.date !== inventoryDate) continue; // latest snapshot only
        const asin = String(r.child_asin || "").trim();
        if (!asin) continue;
        asinSet.add(asin);
        const cur = invByAsin[asin] || (invByAsin[asin] = {
          available: 0, fcTransfer: 0, fcProcessing: 0,
          inboundShipped: 0, inboundReceived: 0, inboundWorking: 0,
        });
        cur.available += num(r.available);
        cur.fcTransfer += num(r.reserved_fc_transfer);
        cur.fcProcessing += num(r.reserved_fc_processing);
        cur.inboundShipped += num(r.inbound_shipped);
        cur.inboundReceived += num(r.inbound_received);
        cur.inboundWorking += num(r.inbound_working);
        const sku = String(r.sku || "").trim();
        if (sku) (skusByAsin[asin] || (skusByAsin[asin] = new Set())).add(sku);
        const nm = String(r.product_name || "").trim();
        if (nm && !invProductName.has(asin)) invProductName.set(asin, nm);
        // Per-marketplace roll-up for Brand View. `brandByAsin` is the same
        // catalog map the per-ASIN rows use, so a brand's country inventory can
        // never disagree with its shipment-plan inventory.
        const invCountry = String(r.marketplace_country_code || account?.country || "").trim().toUpperCase();
        const invBrand = brandByAsin.get(asin) || null;
        const countryBrandKey = `${invCountry}|${invBrand || ""}`;
        const bucket = invByCountryBrand.get(countryBrandKey)
          || { country: invCountry || null, brand: invBrand, fbaAvailable: 0, skus: new Set() };
        bucket.fbaAvailable += num(r.available);
        if (sku) bucket.skus.add(sku);
        invByCountryBrand.set(countryBrandKey, bucket);
      }
      const inventoryAvailable = invRows.length > 0;

      // 5) AWD available (US only), folded from SKU to ASIN.
      const awdByAsin = {};
      let awdAvailable = false;
      if (isUS) {
        const awdRows = await fetchExportRows(
          apiKey, LISTINGS_SOURCE_ID, LISTINGS_AWD_COLUMNS, sellerOrVendorIds,
          null, null, CATALOG_ROW_LIMIT,
          { orderByColumn: "child_asin" }
        );
        awdAvailable = awdRows.length > 0;
        for (const r of awdRows) {
          const asin = String(r.child_asin || "").trim();
          if (!asin) continue;
          awdByAsin[asin] = (awdByAsin[asin] || 0) + num(r.awd_available_distributable_quantity);
          const sku = String(r.sku || "").trim();
          if (sku) (skusByAsin[asin] || (skusByAsin[asin] = new Set())).add(sku);
        }
      }

      // 6) Assemble one row per ASIN. Representative SKU = first non-empty SKU
      // in ascending (localeCompare) order, so it is stable across refreshes.
      // Only ASINs with real activity are kept: any unit sales in the window, or
      // any live FBA/AWD stock. This drops the large tail of zero-sales,
      // zero-stock ASINs that the Product Catalog lists but Order Line Items never sold.
      const rows = [];
      for (const asin of asinSet) {
        const inv = invByAsin[asin] || null;
        const skus = skusByAsin[asin] ? [...skusByAsin[asin]].sort((a, b) => a.localeCompare(b)) : [];
        const unitsByMonth = {};
        let salesTotal = 0;
        for (const mo of completed) {
          const u = num(unitsByAsinByMonth[asin]?.[mo.key]);
          unitsByMonth[mo.key] = u;
          salesTotal += u;
        }
        const mtdUnits = num(mtdByAsin.get(asin));
        salesTotal += mtdUnits;
        const invTotal = inv
          ? inv.available + inv.fcTransfer + inv.fcProcessing + inv.inboundShipped + inv.inboundReceived + inv.inboundWorking
          : 0;
        const awdUnits = isUS ? num(awdByAsin[asin]) : 0;
        if (salesTotal <= 0 && invTotal <= 0 && awdUnits <= 0) continue;
        // DataDoe's FBA Inventory Health snapshot can include the same units in
        // both `reserved_fc_transfer` and `inbound_shipped`. Amazon exposes
        // that overlap only as Inbound, so subtract it from the FC-transfer
        // reserve before returning the planning components. This preserves a
        // genuine residual FC-transfer balance without double-counting stock.
        const adjustedFcTransfer = inv ? Math.max(0, inv.fcTransfer - inv.inboundShipped) : 0;
        rows.push({
          asin,
          productName: nameByAsin.get(asin) || invProductName.get(asin) || null,
          brand: brandByAsin.get(asin) || null,
          sku: skus[0] || null,
          unitsByMonth,
          mtdUnits,
          // Inventory numbers: when the snapshot exists but this ASIN is absent,
          // it genuinely holds no FBA stock (0). When the whole snapshot is
          // unavailable, inventory fields are null so the UI can flag it.
          fbaAvailable: inventoryAvailable ? num(inv?.available) : null,
          reservedFcTransfer: inventoryAvailable ? adjustedFcTransfer : null,
          reservedFcProcessing: inventoryAvailable ? num(inv?.fcProcessing) : null,
          inboundShipped: inventoryAvailable ? num(inv?.inboundShipped) : null,
          inboundReceived: inventoryAvailable ? num(inv?.inboundReceived) : null,
          inboundWorking: inventoryAvailable ? num(inv?.inboundWorking) : null,
          awdAvailable: isUS ? awdUnits : null,
        });
      }

      await sendLegacyPayload({
        asOf: String(to),
        accountName: account?.name || null,
        marketCountry: account?.country || null,
        isUS,
        months: completed,
        currentMonth: current,
        salesLatestDate,
        elapsedDays,
        inventoryDate,
        inventoryAvailable,
        awdAvailable,
        rows,
        // Additive: consumed only by the account-scoped Brand View. Bounded by
        // (marketplaces x brands), so it stays small for accounts with
        // thousands of SKUs.
        inventoryByBrandCountry: [...invByCountryBrand.values()].map(({ skus, ...entry }) => ({
          ...entry,
          skuCount: skus.size,
        })),
      });
      return;
    }

    /* ============================================================
       Insight reports.
       All six share one contract: without `refresh=1` the request only reads
       the shared Supabase snapshot and never touches DataDoe, so navigation,
       brand changes, filters, search, sorting and paging cost nothing. With
       `refresh=1` a database lock is claimed first, so two people clicking
       Refresh cannot spend DataDoe tokens twice, and the validated result is
       saved once for every user permitted on that account.
       ============================================================ */

    if (action === "sales-movers") {
      const ids = singleAccountId(req, res, "Sales Movers");
      if (!ids) return;
      const to = reportAsOf(req, res);
      if (!to) return;
      await serveSharedReport({
        res,
        refresh: wantsRefresh(req),
        reportKey: SALES_MOVERS_REPORT_KEY,
        reportVersion: SALES_MOVERS_VERSION,
        accountId: accountScope.accountIds[0],
        params: { to },
        userId: access.userId,
        label: "Sales Movers",
        build: () => buildSalesMovers({ apiKey, ids, to }),
      });
      return;
    }

    if (action === "listing-health") {
      const ids = singleAccountId(req, res, "Listing Health");
      if (!ids) return;
      const to = reportAsOf(req, res);
      if (!to) return;
      await serveSharedReport({
        res,
        refresh: wantsRefresh(req),
        reportKey: LISTING_HEALTH_REPORT_KEY,
        reportVersion: LISTING_HEALTH_VERSION,
        accountId: accountScope.accountIds[0],
        params: { to },
        userId: access.userId,
        label: "Listing Health",
        build: () => buildListingHealth({ apiKey, ids, to }),
      });
      return;
    }

    if (action === "buy-box-loss") {
      const ids = singleAccountId(req, res, "Buy Box Loss");
      if (!ids) return;
      const to = reportAsOf(req, res);
      if (!to) return;
      await serveSharedReport({
        res,
        refresh: wantsRefresh(req),
        reportKey: BUY_BOX_REPORT_KEY,
        reportVersion: BUY_BOX_VERSION,
        accountId: accountScope.accountIds[0],
        params: { to },
        userId: access.userId,
        label: "Buy Box Loss",
        build: () => buildBuyBoxLoss({ apiKey, ids, to }),
      });
      return;
    }

    if (action === "returns-leakage") {
      const ids = singleAccountId(req, res, "Returns & Refund Leakage");
      if (!ids) return;
      const to = reportAsOf(req, res);
      if (!to) return;
      await serveSharedReport({
        res,
        refresh: wantsRefresh(req),
        reportKey: RETURNS_REPORT_KEY,
        reportVersion: RETURNS_VERSION,
        accountId: accountScope.accountIds[0],
        params: { to },
        userId: access.userId,
        label: "Returns & Refund Leakage",
        build: () => buildReturnsLeakage({ apiKey, ids, to }),
      });
      return;
    }

    // PPC reads the persisted Supabase Ads history, never a live Ads export.
    // Only its small total-sales figure (needed for TACoS) touches DataDoe, and
    // only on an explicit refresh.
    if (action === "ppc-performance") {
      const ids = singleAccountId(req, res, "PPC Performance");
      if (!ids) return;
      const to = reportAsOf(req, res);
      if (!to) return;
      await serveSharedReport({
        res,
        refresh: wantsRefresh(req),
        reportKey: PPC_REPORT_KEY,
        reportVersion: PPC_VERSION,
        accountId: accountScope.accountIds[0],
        params: { to },
        userId: access.userId,
        label: "PPC Performance",
        build: () => buildPpcPerformance({ apiKey, ids, accountId: accountScope.accountIds[0], to }),
      });
      return;
    }

    if (action === "listing-optimizer") {
      const ids = singleAccountId(req, res, "Listing & Search Optimizer");
      if (!ids) return;
      const to = reportAsOf(req, res);
      if (!to) return;
      await serveSharedReport({
        res,
        refresh: wantsRefresh(req),
        reportKey: OPTIMIZER_REPORT_KEY,
        reportVersion: OPTIMIZER_VERSION,
        accountId: accountScope.accountIds[0],
        params: { to },
        userId: access.userId,
        label: "Listing & Search Optimizer",
        build: () => buildListingOptimizer({ apiKey, ids, to }),
      });
      return;
    }

    // Temporary discovery route to find DataDoe's advertising data source and
    // its column names. Hit this once on the live deployment, e.g.
    //   /api/datadoe?action=fields
    //   /api/datadoe?action=fields&sourceId=<id>
    // then read the JSON to identify the ad source id + ad sales/spend/clicks
    // column names, wire them into the "sales" export columns (or a new
    // "ads" action), and remove this route afterwards.
    if (action === "fields") {
      const sourceId = req.query.sourceId || DAILY_SALES_SOURCE_ID;
      const candidates = [
        `${BASE}/sources`,
        `${BASE}/util/sources`,
        `${BASE}/data-sources`,
        `${BASE}/util/data-sources`,
        `${BASE}/util/data-models`,
        `${BASE}/sources/${sourceId}`,
        `${BASE}/sources/${sourceId}/columns`,
        `${BASE}/util/sources/${sourceId}`,
        `${BASE}/util/sources/${sourceId}/columns`,
      ];
      const results = {};
      for (const url of candidates) {
        try {
          const r = await fetch(url, { headers: authHeaders(apiKey) });
          const text = await r.text().catch(() => "");
          results[url] = { status: r.status, ok: r.ok, body: text.slice(0, 4000) };
        } catch (e) {
          results[url] = { error: e instanceof Error ? e.message : String(e) };
        }
        // Stay under DataDoe's ~2 req/sec org rate limit while probing.
        await new Promise((resolve) => setTimeout(resolve, 550));
      }
      res.status(200).json({ sourceId, note: "Discovery route — identify the ad source id + column names, then remove this action.", results });
      return;
    }

    // Temporary discovery route: pull a small real sample from a source (no
    // columns specified) to reveal its actual column names and row granularity.
    //   /api/datadoe?action=sample&sourceId=401ffcd7e5
    // Remove this route once the source/columns are confirmed.
    if (action === "sample") {
      const sourceId = req.query.sourceId || DAILY_SALES_SOURCE_ID;
      let ids = req.query.ids;
      if (!ids) {
        const accts = await fetchAccounts(apiKey);
        const aak = accts.find((a) => /aakriti/i.test(a.name));
        ids = accts.length ? (aak || accts[0]).id : "";
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean).slice(0, MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT);
      const to = req.query.to || new Date().toISOString().slice(0, 10);
      const from = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const limit = Number(req.query.limit) || 200;
      // Columns must be specified (DataDoe rejects an empty/absent list). Pass
      // ?columns=a,b,c to probe arbitrary columns, else default by source.
      let columns;
      if (req.query.columns) columns = String(req.query.columns).split(",").map((c) => c.trim()).filter(Boolean);
      else if (sourceId === DAILY_SALES_SOURCE_ID) columns = DAILY_SALES_COLUMNS;
      else if (sourceId === DASHBOARD_SOURCE_ID) columns = DASHBOARD_COLUMNS;
      else if (sourceId === ADS_SOURCE_ID) columns = ADS_COLUMNS;
      else columns = ["date", "seller_or_vendor_id"];

      // Sources without a date column need a different orderBy and no date
      // range; pass ?orderBy=<col> and omit from/to for those.
      const orderByColumn = req.query.orderBy || "date";
      const createRes = await ddFetch(ENDPOINTS.exportsCreate, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify({ sourceId, sellerOrVendorIds, columns, ...(from ? { from } : {}), ...(to ? { to } : {}), limit, outputType: "JSON", orderByColumn, orderByDirection: "ASC" }),
      });
      const createText = await createRes.text().catch(() => "");
      if (!createRes.ok) {
        res.status(200).json({ sourceId, from, to, columns, sellerOrVendorIds, ok: false, stage: "create", status: createRes.status, body: createText.slice(0, 2000) });
        return;
      }
      let created = {};
      try { created = JSON.parse(createText); } catch (e) { /* leave empty */ }
      const exportId = created.exportId || created.id;
      if (created.status !== "COMPLETED") {
        try {
          await pollExport(apiKey, exportId);
        } catch (e) {
          res.status(200).json({ sourceId, from, to, columns, sellerOrVendorIds, ok: false, stage: "poll", error: e instanceof Error ? e.message : String(e) });
          return;
        }
      }
      const rows = await downloadExport(apiKey, exportId);
      // Summaries to diagnose granularity/magnitude without dumping everything.
      const salesSum = rows.reduce((a, r) => a + (Number(r.total_sales) || 0), 0);
      const unitsSum = rows.reduce((a, r) => a + (Number(r.total_units) || 0), 0);
      const dates = rows.map((r) => r.date).filter(Boolean);
      res.status(200).json({
        sourceId, from, to, columns, sellerOrVendorIds, ok: true,
        rowCount: rows.length,
        rowKeys: rows.length ? Object.keys(rows[0]) : [],
        distinctDates: new Set(dates).size,
        minDate: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
        maxDate: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
        salesSum, unitsSum,
        sample: rows.slice(0, 8),
      });
      return;
    }

    res.status(400).json({ error: "Unknown action. Use ?action=accounts, ?action=brand-directory, ?action=brand-portfolio, ?action=brand-view-brands, ?action=brand-view, ?action=brand-view-portfolio, ?action=fx-rates, ?action=sales, ?action=brand-sales, ?action=daily, ?action=reconciliation, ?action=sku-pl, ?action=keyword-rank, ?action=content-changes, ?action=fba-plan, ?action=fields, or ?action=sample" });
  } catch (err) {
    // Typed DataDoe deadline / poll-pending / continuation signals get fixed safe messages and a
    // retryable flag that is true ONLY when a durable continuation exists (see the classifier).
    const mapped = classifyDataDoeRouteError(err);
    if (mapped) {
      res.status(mapped.status).json(mapped.body);
      return;
    }
    const status = err instanceof DashboardAccessError ? err.status : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : "Unexpected server error." });
  } finally {
    await legacySharedRefresh?.release();
  }
}
