import {
  claimRefreshLock,
  releaseRefreshLock,
  getAdsSyncStates,
  upsertAdDailyMetrics,
  upsertAdsDailyRows,
  deleteAdsDailySourceRows,
  upsertAdsSyncStates,
  recordAdsCoverageWindows,
  getDailyAdsCoverage,
} from "./supabase.js";
import { getDataDoeConnections, publicAccountId } from "./datadoe-connections.js";
// PURE durable-coverage proof (server-only; no transport import) -- used to skip an already-covered
// requiredCoverage pair. Reused from the PPC loader so the "complete window proven" rule is IDENTICAL to the
// gate the PPC report itself applies. No import cycle (ppc-ads-loader imports no transport/ads-sync).
import { evaluateSourceCoverage } from "./sync/ppc-ads-loader.js";
// The AUTHORITATIVE per-row currency (marketplace-derived when the ASIN payload omits it). Shared with the read
// aggregations so persist + read agree, and a blank ASIN currency is never stored as "" (which downstream would
// fail closed as ads-currency-missing).
import { resolveAdRowCurrency } from "./reports/asin-ads-aggregation.js";
import { marketplaceProfile } from "../marketplaces.js";

// Two marketplace codes identify the SAME marketplace when they are equal, or when both are CONFIGURED
// marketplaces resolving to the same country -- Amazon returns the ISO "GB" for the UK while the account
// directory carries "UK", so an exact-match on the raw codes would wrongly reject every UK account's rows. Two
// UNKNOWN codes never match (both fall back to the generic profile), so cross-marketplace contamination is still
// caught. Pure.
export function sameMarketplace(rowMarketplace, accountCountry) {
  const a = String(rowMarketplace || "").trim().toUpperCase();
  const b = String(accountCountry || "").trim().toUpperCase();
  if (!a || !b) return false;
  if (a === b) return true;
  const pa = marketplaceProfile(a), pb = marketplaceProfile(b);
  return pa.countryName !== "Marketplace" && pa.countryName === pb.countryName;
}

const BASE = "https://api.datadoe.com/api/v1";
// The DataDoe REST Export API has NO row-data cap (DataDoe confirmed in writing; the transient HTTP 400 that
// briefly limited some REST callers to 5000 rows was a DataDoe-side incident, since resolved -- the 5000 cap
// applies only to MCP, which this dashboard does NOT use). A single REST export therefore returns the WHOLE
// <=5-seller window in one page; `limit` is set to a high ceiling (matching the other REST sources) purely as a
// safety bound, never as a per-5000 pagination trigger. SKIP-PAGINATION (fetchAllPages) is now only a FAIL-SAFE:
// a page is fetched again ONLY when it returns the FULL limit (the sole explicit truncation signal), NEVER merely
// because it crossed 5000. With the reduced ASIN/date grain an export is far below this ceiling -> a single page.
export const EXPORT_LIMIT = 50000;
// The DataDoe five-seller-id chunk. Also the requiredCoverage allowlist ceiling: a bounded canary must fit in
// ONE export batch per source (so it can never become an accidental organization-wide run).
export const MAX_IDS_PER_EXPORT = 5;
const POLL_DELAY_MS = 5000;
// A larger export can take well over a minute to complete server-side; 9 attempts (45s) timed out real ASIN Ads
// exports. 24 attempts (~120s) gives a slow export room to finish (a timeout wastes the create + returns nothing).
const POLL_ATTEMPTS = 24;
const WORK_BUDGET_MS = 300000; // one invocation processes more batches before deferring (slow exports poll longer now)
const MANAGED_COUNTRIES = new Set(["IN", "US", "CA", "AU"]);
const MIN_REQUEST_INTERVAL_MS = 550;
let lastDataDoeRequestAt = 0;

export const ADS_SOURCES = [
  {
    key: "campaign-performance-v1",
    sourceId: "08cdc77d3dc24a7651553e2e926f598188c66172f64cd6512265900af6073a6c",
    initialDays: 56,
    dailyDays: 21,
    monthlyDays: 49,
    batchSize: 5,
    dimensions: [
      "marketplace_id", "marketplace_country_code", "marketplace_country_name",
      "seller_or_vendor_id", "seller_or_vendor_name", "marketplace_seller_id",
      "amazon_ads_profile_id", "date", "ad_campaign_type", "ad_campaign_id",
      "ad_campaign_name", "ad_campaign_status", "ad_campaign_budget_amount",
      "ad_campaign_budget_type", "ad_campaign_budget_currency",
    ],
    metrics: [
      "ad_clicks", "ad_sales", "ad_impressions", "ad_spend", "ad_units_sold",
      "ad_orders", "ad_gross_impressions", "ad_invalid_impressions",
      "ad_invalid_impression_rate", "ad_gross_click_throughs",
      "ad_invalid_click_throughs", "ad_invalid_click_through_rate",
    ],
    keyFields: ["ad_campaign_id", "ad_campaign_type"],
  },
  {
    // REDUCED to the ACCOUNT / DATE / ASIN grain Daily Reporting + Brand View actually consume. The campaign /
    // ad-group / ad-level dimensions are dropped and the six same-SKU metrics are SUMMED SERVER-SIDE (groupBy +
    // aggregations), so an export stays far under the 5000-row page cap instead of exploding to campaign grain
    // (e.g. 90 aggregated rows vs 376 campaign rows for one 21-day seller). DataDoe forbids an aggregation alias
    // equal to a source column (ALIAS_COLLISION), so each metric is summed into a distinct "<metric>_sum" alias
    // and mapped back to its canonical name on persist (rowRecord). This is ONLY the reusable ASIN Ads source for
    // Daily/Brand -- the Campaign/PPC (campaign-performance-v1) + targeting/search-term contracts are unchanged.
    key: "asin-performance-v1",
    sourceId: "d0017e92fb089c2c8c3fe65f81d08666ecb4fe937ffbce9969ce2fc7d28c805c",
    initialDays: 60,
    dailyDays: 21,
    monthlyDays: 49,
    batchSize: MAX_IDS_PER_EXPORT,
    dimensions: [
      "marketplace_country_code", "seller_or_vendor_id", "date", "child_asin",
    ],
    metrics: [
      "ad_sales_same_sku", "ad_clicks", "ad_impressions", "ad_spend",
      "ad_units_sold_same_sku", "ad_orders_same_sku",
    ],
    keyFields: ["child_asin"],
    groupBy: ["marketplace_country_code", "seller_or_vendor_id", "date", "child_asin"],
    aggregations: [
      { column: "ad_sales_same_sku", aggregation: "sum", alias: "ad_sales_same_sku_sum" },
      { column: "ad_clicks", aggregation: "sum", alias: "ad_clicks_sum" },
      { column: "ad_impressions", aggregation: "sum", alias: "ad_impressions_sum" },
      { column: "ad_spend", aggregation: "sum", alias: "ad_spend_sum" },
      { column: "ad_units_sold_same_sku", aggregation: "sum", alias: "ad_units_sold_same_sku_sum" },
      { column: "ad_orders_same_sku", aggregation: "sum", alias: "ad_orders_same_sku_sum" },
    ],
  },
  {
    key: "keyword-targeting-performance-v1",
    sourceId: "bbba3d213ac78ccbaf22cfa68eecb3f475641f49da26d51d1ac36446310051e3",
    initialDays: 56,
    dailyDays: 21,
    monthlyDays: 49,
    batchSize: MAX_IDS_PER_EXPORT,
    dimensions: [
      "marketplace_id", "marketplace_country_code", "marketplace_country_name",
      "seller_or_vendor_id", "seller_or_vendor_name", "marketplace_seller_id",
      "amazon_ads_profile_id", "date", "ad_targeting_text", "ad_targeting_id",
      "ad_keyword_id", "ad_keyword", "ad_keyword_expression", "ad_keyword_status",
      "ad_match_type", "ad_matched_target_asin", "ad_campaign_id", "ad_campaign_name",
      "ad_campaign_type", "ad_portfolio_id", "ad_portfolio_name", "ad_campaign_status",
      "ad_campaign_budget_amount", "ad_campaign_budget_type", "ad_campaign_budget_currency",
      "ad_group_id", "ad_group_name",
    ],
    metrics: [
      "ad_orders", "ad_orders_same_sku", "ad_units_sold_click", "ad_sales",
      "ad_spend", "ad_impressions", "ad_clicks", "ad_top_of_search_impression_share",
    ],
    keyFields: ["ad_targeting_id", "ad_keyword_id", "ad_campaign_id", "ad_group_id", "ad_campaign_type"],
  },
  {
    // Search Term Performance (Ads). Added so the PPC report can read customer
    // search terms from Supabase instead of making every browser export them.
    // IMPORTANT: this source's documented ad_campaign_type values are
    // SPONSORED_BRANDS or SPONSORED_PRODUCTS and its DataDoe dependencies are
    // only the SB/SP search-term reports, so it is SP + SB and must never be
    // presented as covering Sponsored Display. Keyword Targeting Performance is
    // the SP + SB + SD source.
    // Not a default DataDoe table: an organisation that has not enabled it will
    // fail this source only, leaving the other three unaffected.
    key: "search-terms-performance-v1",
    sourceId: "e94e9671989ce4aa2814ac729807c7ddcc1cc47a71ebcd75d9fe661ed80335be",
    initialDays: 60,
    dailyDays: 21,
    monthlyDays: 49,
    batchSize: MAX_IDS_PER_EXPORT,
    dimensions: [
      "marketplace_id", "marketplace_country_code", "marketplace_country_name",
      "seller_or_vendor_id", "seller_or_vendor_name", "marketplace_seller_id",
      "amazon_ads_profile_id", "date", "ad_search_term", "ad_targeting_text",
      "ad_keyword_id", "ad_keyword", "ad_keyword_status", "ad_match_type",
      "ad_campaign_id", "ad_campaign_name", "ad_campaign_type",
      "ad_portfolio_id", "ad_portfolio_name", "ad_campaign_status",
      "ad_campaign_budget_amount", "ad_campaign_budget_type", "ad_campaign_budget_currency",
      "ad_group_id", "ad_group_name",
    ],
    metrics: [
      "ad_spend", "ad_sales", "ad_clicks", "ad_impressions", "ad_orders",
      "ad_orders_same_sku", "ad_units_sold_click",
    ],
    keyFields: ["ad_search_term", "ad_keyword_id", "ad_campaign_id", "ad_group_id", "ad_campaign_type"],
  },
];

// The canonical requiredCoverage window ceiling: the LARGEST initial backfill any Ads source declares. A
// bounded coverage canary can request at most this many inclusive calendar days -- never an arbitrary span.
// Currently 60 (asin/search-terms initialDays). Derived, so it can never drift from the source contracts.
export const MAX_REQUIRED_COVERAGE_DAYS = Math.max(...ADS_SOURCES.map((source) => source.initialDays));

// HARD recursive create-export ceiling for ONE requiredCoverage invocation: the parent export plus at most two
// child exports from a single row-cap split. A fourth create attempt fails closed with a typed/admin-safe
// ADS_COVERAGE_EXPORT_BUDGET_EXCEEDED error, so a runaway split can never spend unbounded DataDoe tokens.
export const MAX_REQUIRED_COVERAGE_CREATE_EXPORTS = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addDays(date, offset) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function daysBetween(older, newer) {
  return Math.floor((Date.parse(newer) - Date.parse(older)) / 86400000);
}

function authHeaders(apiKey) {
  return { "Content-Type": "application/json", "datadoe-api-key": apiKey };
}

async function datadoeFetch(url, options, attempt = 0) {
  const waitFor = Math.max(0, MIN_REQUEST_INTERVAL_MS - (Date.now() - lastDataDoeRequestAt));
  if (waitFor) await sleep(waitFor);
  lastDataDoeRequestAt = Date.now();
  const response = await fetch(url, options);
  if (response.status === 429 && attempt < 4) {
    const retryAfter = Number(response.headers.get("retry-after")) || 1;
    await sleep(retryAfter * 1000 + 250);
    return datadoeFetch(url, options, attempt + 1);
  }
  return response;
}

async function fetchAccounts(apiKey) {
  const response = await datadoeFetch(`${BASE}/util/sellers-and-vendors`, { headers: authHeaders(apiKey) });
  if (!response.ok) throw new Error(`DataDoe accounts request failed (${response.status}).`);
  const body = await response.json();
  const list = body.data || body.results || (Array.isArray(body) ? body : []);
  return list.map((account) => ({
    id: String(account.id || ""),
    country: String(account.marketplaceCountryCode || "").toUpperCase(),
  })).filter((account) => account.id);
}

// PURE: the exact create-export request body for one page. When the source declares server-side aggregations,
// only the grain DIMENSIONS are requested as columns (the metrics arrive as the aggregation aliases) and groupBy +
// aggregations are attached; otherwise the raw dimensions + metrics are requested as before. `skip` is the ONLY
// field that changes between pages of the same window. Exported so the grain/limit/pagination contract is a
// regression, not a source-text claim.
export function buildAdsExportRequestBody(source, ids, from, to, skip = 0) {
  const aggregating = Array.isArray(source.aggregations) && source.aggregations.length > 0;
  const columns = aggregating ? [...source.dimensions] : [...source.dimensions, ...source.metrics];
  return {
    sourceId: source.sourceId,
    sellerOrVendorIds: ids,
    columns,
    from,
    to,
    limit: EXPORT_LIMIT,
    skip,
    outputType: "JSON",
    orderByColumn: "date",
    orderByDirection: "ASC",
    ...(aggregating ? { groupBy: source.groupBy, aggregations: source.aggregations } : {}),
  };
}

async function createExport(apiKey, source, ids, from, to, skip = 0) {
  const response = await datadoeFetch(`${BASE}/exports`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(buildAdsExportRequestBody(source, ids, from, to, skip)),
  });
  if (!response.ok) {
    throw new Error(`DataDoe ${source.key} export creation failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  }
  return response.json();
}

// Poll one export to COMPLETED, then return BOTH the completed-export metadata `rowCount` AND the downloaded raw
// array. The caller (validateExportPage) fails closed on any status/rowCount/array/length mismatch so a torn or
// partial page is never persisted.
async function downloadExport(apiKey, exportId) {
  let completed = null;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const status = await datadoeFetch(`${BASE}/exports/${exportId}`, { headers: authHeaders(apiKey) });
    if (!status.ok) throw new Error(`DataDoe export status failed (${status.status}).`);
    const body = await status.json();
    if (body.status === "COMPLETED") { completed = body; break; }
    if (["FAILED", "ERROR", "BLOCKED_NO_TOKENS"].includes(body.status)) {
      throw new Error(`DataDoe ${body.status} while exporting Ads data.`);
    }
    if (attempt === POLL_ATTEMPTS - 1) throw new Error("DataDoe Ads export timed out.");
    await sleep(POLL_DELAY_MS);
  }
  const response = await datadoeFetch(`${BASE}/exports/${exportId}/raw`, { headers: authHeaders(apiKey) });
  if (!response.ok) throw new Error(`DataDoe export download failed (${response.status}).`);
  const body = await response.json();
  const rows = typeof body.rawContent === "string" ? JSON.parse(body.rawContent) : (Array.isArray(body) ? body : (Array.isArray(body.rows) ? body.rows : null));
  // rowCount from the COMPLETED export metadata (accept a top-level or a metadata-nested field; anything else
  // stays null so validateExportPage fails closed on a missing count).
  const rc = completed ? (completed.rowCount ?? (completed.metadata && completed.metadata.rowCount)) : null;
  return { status: completed ? completed.status : null, rowCount: rc == null ? null : Number(rc), rows };
}

// Validate one export page using BOTH the metadata rowCount AND the raw array length. Fails closed (throws) on:
// status != COMPLETED, a non-nonnegative-integer / missing rowCount, a non-array raw payload, a raw length that
// disagrees with rowCount, or a rowCount above the page limit. Returns the validated rows on success. Pure.
export function validateExportPage({ status, rowCount, rows }) {
  if (status !== "COMPLETED") throw new Error(`ADS_EXPORT_PAGE_INVALID: status ${status} != COMPLETED (fail closed).`);
  if (!Number.isInteger(rowCount) || rowCount < 0) throw new Error(`ADS_EXPORT_PAGE_INVALID: rowCount ${rowCount} is not a nonnegative integer (fail closed).`);
  if (!Array.isArray(rows)) throw new Error("ADS_EXPORT_PAGE_INVALID: raw payload is not an array (fail closed).");
  if (rows.length !== rowCount) throw new Error(`ADS_EXPORT_PAGE_INVALID: raw length ${rows.length} != metadata rowCount ${rowCount} (fail closed).`);
  if (rowCount > EXPORT_LIMIT) throw new Error(`ADS_EXPORT_PAGE_INVALID: rowCount ${rowCount} > page limit ${EXPORT_LIMIT} (fail closed).`);
  return rows;
}

// The raw-row natural grain (the persist PK before public-account mapping): the same keyFields the durable
// dimension_key is built from, plus seller/marketplace/date. Used to deduplicate rows concatenated across pages.
function adsRawNaturalKey(source, row) {
  return JSON.stringify([
    String(row.seller_or_vendor_id || ""),
    String(row.marketplace_country_code || "").toUpperCase(),
    String(row.date || ""),
    source.keyFields.map((key) => row[key] ?? null),
  ]);
}
function dedupeAdsRawRows(source, rows) {
  const byKey = new Map();
  for (const row of rows) byKey.set(adsRawNaturalKey(source, row), row); // later page wins on the natural grain
  return [...byKey.values()];
}

// Fetch the COMPLETE [from,to] window by SKIP-PAGINATION. `create`/`download` are INJECTED (network in production;
// deterministic doubles in tests). page 0 uses skip=0; while a page returns EXACTLY EXPORT_LIMIT rows the next
// page is fetched (skip += EXPORT_LIMIT); a page returning FEWER than EXPORT_LIMIT rows (including empty) proves
// completion. Every page keeps the SAME seller set / columns / filters / date range / grouping / ordering -- ONLY
// skip changes -- and is validated (validateExportPage) before it is accepted; the concatenated rows are then
// deduplicated by the complete natural grain. `budget` (when present) is an invocation-scoped { count, max }
// enforced BEFORE every create-export POST, so a bounded coverage canary can never create more than `max` pages.
async function fetchAllPages(create, download, apiKey, source, ids, from, to, budget) {
  const all = [];
  let skip = 0;
  for (;;) {
    if (budget) {
      if (budget.count >= budget.max) {
        const error = new Error(`ADS_COVERAGE_EXPORT_BUDGET_EXCEEDED (max ${budget.max} create-exports per requiredCoverage invocation)`);
        error.code = "ADS_COVERAGE_EXPORT_BUDGET_EXCEEDED";
        throw error;
      }
      budget.count += 1;
    }
    const created = await create(apiKey, source, ids, from, to, skip);
    const page = await download(apiKey, created.exportId || created.id);
    const rows = validateExportPage(page); // fails closed on any status/rowCount/length mismatch (persists nothing)
    for (const row of rows) all.push(row);
    if (page.rowCount < EXPORT_LIMIT) break; // a short/empty page proves completion -- NEVER inferred from a full page
    skip += EXPORT_LIMIT;                     // a full page => there may be more; fetch the next page
  }
  return dedupeAdsRawRows(source, all);
}

function chunks(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

function pickMode(state, source, now) {
  if (!state?.initial_seeded_at) return "initial";
  if (!state.last_monthly_sync_at || daysBetween(state.last_monthly_sync_at, now) >= 25) return "monthly";
  return "daily";
}

function windowFor(source, mode, to) {
  const days = mode === "initial" ? source.initialDays : mode === "monthly" ? source.monthlyDays : source.dailyDays;
  return { from: addDays(to, -(days - 1)), to };
}

function rowRecord(source, row, refreshedAt, connection) {
  const rawAccountId = String(row.seller_or_vendor_id || "");
  const date = String(row.date || "");
  if (!rawAccountId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`${source.key} returned a row without seller_or_vendor_id or a valid date.`);
  }
  const accountId = publicAccountId(connection, rawAccountId);
  const dimensions = Object.fromEntries(source.dimensions.map((key) => [key, row[key] ?? null]));
  // When the source aggregates server-side, each metric arrives under its distinct "<metric>_sum" alias; map it
  // back to the CANONICAL metric name so the persisted `metrics` JSONB (and every downstream reader) is unchanged.
  const aliasFor = Array.isArray(source.aggregations) ? Object.fromEntries(source.aggregations.map((a) => [a.column, a.alias])) : {};
  const metrics = Object.fromEntries(source.metrics.map((key) => [key, (aliasFor[key] ? row[aliasFor[key]] : row[key]) ?? row[key] ?? null]));
  // JSON preserves empty fields and delimiters, so natural dimensions cannot
  // collide merely because an Amazon value itself contains a pipe character.
  const dimensionKey = JSON.stringify(source.keyFields.map((key) => row[key] ?? null));
  return {
    source_key: source.key,
    account_id: accountId,
    marketplace_country_code: String(row.marketplace_country_code || "").toUpperCase(),
    metric_date: date,
    dimension_key: dimensionKey,
    campaign_id: String(row.ad_campaign_id || ""),
    campaign_type: String(row.ad_campaign_type || ""),
    child_asin: String(row.child_asin || ""),
    targeting_id: String(row.ad_targeting_id || row.ad_keyword_id || ""),
    // AUTHORITATIVE currency: explicit row currency wins; otherwise the row's marketplace fixes it (the ASIN grain
    // supplies no currency). Persisting the resolved currency keeps the durable row usable by the per-account
    // isolation check instead of a "" that would be blocked as ads-currency-missing.
    currency: resolveAdRowCurrency(row),
    dimensions,
    metrics,
    source_refreshed_at: refreshedAt,
  };
}

function campaignMetricRecords(rows) {
  return rows.map((row) => ({
    account_id: row.account_id,
    metric_date: row.metric_date,
    campaign_id: row.campaign_id,
    campaign_type: row.campaign_type,
    currency: row.currency,
    ad_sales: Number(row.metrics.ad_sales) || 0,
    ad_spend: Number(row.metrics.ad_spend) || 0,
    ad_clicks: Math.round(Number(row.metrics.ad_clicks) || 0),
    source_refreshed_at: row.source_refreshed_at,
  }));
}

function stateRecord(accountId, sourceKey, previous, mode, latestMetricDate, now) {
  return {
    account_id: accountId,
    source_key: sourceKey,
    initial_seeded_at: mode === "initial" ? now : previous?.initial_seeded_at || null,
    last_daily_sync_at: mode === "daily" ? now : previous?.last_daily_sync_at || null,
    last_monthly_sync_at: mode === "monthly" ? now : previous?.last_monthly_sync_at || null,
    latest_metric_date: latestMetricDate || previous?.latest_metric_date || null,
    last_status: "succeeded",
    last_error: null,
  };
}

function failedStateRecord(accountId, sourceKey, previous, error, now) {
  return {
    account_id: accountId,
    source_key: sourceKey,
    initial_seeded_at: previous?.initial_seeded_at || null,
    last_daily_sync_at: previous?.last_daily_sync_at || null,
    last_monthly_sync_at: previous?.last_monthly_sync_at || null,
    latest_metric_date: previous?.latest_metric_date || null,
    last_status: "failed",
    last_error: String(error.message || error).slice(0, 1000),
    updated_at: now,
  };
}

function countryMatches(account, countries) {
  return countries === "OTHER" ? !MANAGED_COUNTRIES.has(account.country) : countries.includes(account.country);
}

// Successful state record for a BOUNDED requiredCoverage canary. Unlike stateRecord it PRESERVES every cadence
// timestamp (initial/daily/monthly) verbatim -- a controlled exact-window backfill is NOT a normal cadence run,
// so it must never falsely stamp initial_seeded_at / last_daily_sync_at / last_monthly_sync_at. It only advances
// latest_metric_date (from the durably-persisted rows) and marks last_status succeeded.
function coverageStateRecord(accountId, sourceKey, previous, latestMetricDate, now) {
  return {
    account_id: accountId,
    source_key: sourceKey,
    initial_seeded_at: previous?.initial_seeded_at || null,
    last_daily_sync_at: previous?.last_daily_sync_at || null,
    last_monthly_sync_at: previous?.last_monthly_sync_at || null,
    latest_metric_date: latestMetricDate || previous?.latest_metric_date || null,
    last_status: "succeeded",
    last_error: null,
  };
}

/**
 * Validate a DataDoe export result against the EXACT batch it was requested for, BEFORE any row / metric /
 * coverage / success-state write. The whole batch is rejected (a typed safe failure, zero writes) on any
 * malformed / cross-account / unknown-account / missing-id / duplicate-scope / wrong-marketplace evidence:
 *   - the result must be an ARRAY (a non-array result is not evidence);
 *   - every row must be a plain object;
 *   - seller_or_vendor_id must be NONBLANK and EXACTLY one of THIS batch's rawAccountIds;
 *   - it must resolve THROUGH the batch's discovered account object -- the resolved public account id AND the
 *     account's connection must match the batch (so a same-raw-id row from another organisation is rejected);
 *   - when the source declares the marketplace_country_code dimension, the row's marketplace must equal the
 *     discovered account's country.
 * A GENUINE successful export with ZERO rows ([]) is VALID covered-empty evidence. Returns { ok, reason }
 * where reason is a SAFE slug (never a raw row / id / secret). Pure.
 */
function validateExportBatchRows(source, rows, batch, connection) {
  if (!Array.isArray(rows)) return { ok: false, reason: "result-not-an-array" };
  // One raw id -> its discovered account object. The batch shares ONE connection/mode work group and its
  // accounts have distinct raw ids (discovery dedups on the public id), so this map has no duplicate scope.
  const byRawId = new Map(batch.map((entry) => [entry.account.rawAccountId, entry.account]));
  const hasMarketplace = Array.isArray(source.dimensions) && source.dimensions.includes("marketplace_country_code");
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return { ok: false, reason: "non-object-row" };
    const sellerId = String(row.seller_or_vendor_id || "").trim();
    if (!sellerId) return { ok: false, reason: "missing-seller-id" };
    const account = byRawId.get(sellerId);
    if (!account) return { ok: false, reason: "cross-account-or-unknown-seller-id" };
    if (!account.connection || account.connection.id !== connection.id) return { ok: false, reason: "connection-mismatch" };
    if (publicAccountId(account.connection, sellerId) !== account.id) return { ok: false, reason: "public-account-mismatch" };
    if (hasMarketplace) {
      // A row's marketplace must identify the SAME marketplace as the discovered account's country (UK<->GB
      // aliasing included). An unrelated marketplace is still rejected as cross-account contamination.
      if (!sameMarketplace(row.marketplace_country_code, account.country)) return { ok: false, reason: "wrong-marketplace" };
    }
  }
  return { ok: true, reason: null };
}

/**
 * PURE finalizer for a requiredCoverage summary -> a TOTAL coverage-mode result. For N selected accounts x M
 * selected sources, expectedCoveragePairs = N x M and a pair is SUCCESSFUL only when it had durable Ads rows
 * (or a validated empty result), a confirmed exact coverage acknowledgement, AND successful state persistence
 * (each such pair incremented `summary.sources[key].coverage`). Sets:
 *   - expectedCoveragePairs / successfulCoveragePairs;
 *   - coverageComplete = every pair succeeded AND no failure AND not deferred;
 *   - status: completed (all pairs) | partial (some successes with failures, or a work-budget deferral) |
 *     failed (zero successful pairs with at least one failure).
 * `completed` therefore IMPLIES coverageComplete === true and zero failedAccounts/coverageFailedAccounts.
 * `deferred` reflects a work-budget deadline (always => partial). No I/O.
 */
export function finalizeCoverageSummary(summary, { accounts, sourceKeys, deferred = false }) {
  const expectedCoveragePairs = Number(accounts) * (Array.isArray(sourceKeys) ? sourceKeys.length : 0);
  let successfulCoveragePairs = 0;
  const failed = new Set();
  const coverageFailed = new Set();
  for (const key of sourceKeys || []) {
    const s = summary.sources[key] || {};
    successfulCoveragePairs += Number(s.coverage) || 0;
    for (const id of s.failedAccounts || []) failed.add(id);
    for (const id of s.coverageFailedAccounts || []) coverageFailed.add(id);
  }
  const anyFailure = failed.size > 0 || coverageFailed.size > 0;
  const allPairsSucceeded = expectedCoveragePairs > 0 && successfulCoveragePairs === expectedCoveragePairs && !anyFailure && !deferred;

  summary.expectedCoveragePairs = expectedCoveragePairs;
  summary.successfulCoveragePairs = successfulCoveragePairs;
  summary.coverageComplete = allPairsSucceeded;
  if (allPairsSucceeded) {
    summary.status = "completed";
    summary.deferred = false;
  } else if (deferred) {
    summary.status = "partial";
    summary.deferred = true;
  } else if (successfulCoveragePairs === 0 && anyFailure) {
    summary.status = "failed";
    summary.deferred = false;
  } else {
    summary.status = "partial";
    summary.deferred = false;
  }
  return summary;
}

// Strict real YYYY-MM-DD: exact shape AND a real calendar date (round-trips through UTC so 2026-02-30 is rejected).
function isStrictYmd(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// Inclusive calendar-day span of [from..to] via STRICT UTC calendar arithmetic: both endpoints are UTC
// midnights, so the millisecond difference is an exact whole number of days (leap days and year boundaries
// are counted naturally); +1 makes it inclusive (from===to => 1). `from`/`to` are pre-validated strict
// YYYY-MM-DD, so Date.parse never yields NaN here.
export function inclusiveDaySpan(from, to) {
  const f = Date.parse(`${from}T00:00:00.000Z`);
  const t = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((t - f) / 86400000) + 1;
}

/**
 * Validate the BASIC shape of runAdsSync options BEFORE any lock is claimed (fail closed, no lock held on a
 * bad request). Returns the normalized { accountIds, requiredCoverage }. Rules for requiredCoverage (the
 * account-bounded exact-window canary option):
 *   - allowed ONLY with an accountIds allowlist of 1..MAX_IDS_PER_EXPORT ids (it can never widen an unbounded
 *     country sweep, and it fits in ONE export batch per source so it can never go organization-wide);
 *   - strict real YYYY-MM-DD from/to with from <= to; to must not be in the future;
 *   - the inclusive window span must be <= MAX_REQUIRED_COVERAGE_DAYS (the largest Ads-source initial backfill).
 * NOTE: this validates option SHAPE + hard bounds only. Resolving the allowlist against freshly discovered
 * accounts happens AFTER the lock (it needs discovery) and is fail-closed there too.
 */
export function validateAdsSyncOptions(options = {}, today) {
  if (options == null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Ads sync options must be an object (fail closed).");
  }
  const { accountIds = null, requiredCoverage = null } = options;
  if (accountIds != null && !Array.isArray(accountIds)) {
    throw new Error("Ads sync accountIds must be an array of public account ids (fail closed).");
  }
  if (requiredCoverage == null) return { accountIds, requiredCoverage: null };
  if (!Array.isArray(accountIds) || accountIds.length === 0) {
    throw new Error("Ads sync requiredCoverage requires a non-empty accountIds allowlist (fail closed).");
  }
  if (accountIds.length > MAX_IDS_PER_EXPORT) {
    throw new Error(`Ads sync requiredCoverage allows at most ${MAX_IDS_PER_EXPORT} accountIds (one export batch per source); got ${accountIds.length} (fail closed).`);
  }
  if (typeof requiredCoverage !== "object" || Array.isArray(requiredCoverage)) {
    throw new Error("Ads sync requiredCoverage must be an object { from, to } (fail closed).");
  }
  const { from, to } = requiredCoverage;
  if (!isStrictYmd(from) || !isStrictYmd(to)) {
    throw new Error("Ads sync requiredCoverage.from/to must be strict real YYYY-MM-DD dates (fail closed).");
  }
  if (from > to) throw new Error("Ads sync requiredCoverage.from must be <= to (fail closed).");
  if (typeof today === "string" && to > today) throw new Error("Ads sync requiredCoverage.to must not be in the future (fail closed).");
  const days = inclusiveDaySpan(from, to);
  if (days > MAX_REQUIRED_COVERAGE_DAYS) {
    throw new Error(`Ads sync requiredCoverage window is ${days} inclusive days; the maximum is ${MAX_REQUIRED_COVERAGE_DAYS} (fail closed).`);
  }
  return { accountIds, requiredCoverage: { from, to } };
}

export function verifyCronRequest(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(500).json({ error: "CRON_SECRET is not configured." });
    return false;
  }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized cron invocation." });
    return false;
  }
  return true;
}

/**
 * FAIL-CLOSED optional account allowlist for a controlled Ads-sync canary (Gate 6 PPC prerequisite).
 * Pure. `discovered` = the freshly discovered accounts (public ids + their connections) AFTER country
 * filtering; `accountIds` = the exact PUBLIC account ids the caller wants to sync. Returns the selected
 * subset in discovery order. Throws (never a partial/guessed selection) on:
 *   - a malformed allowlist (not a non-empty array of non-blank strings);
 *   - a duplicate id in the allowlist;
 *   - a `dd-secondary:`-prefixed id (a secondary-organization account must NEVER be a canary target and is
 *     never routed through the primary key -- selection only ever picks a DISCOVERED account object, which
 *     carries its OWN connection);
 *   - an id whose discovered account is not on the PRIMARY connection (defense in depth);
 *   - an id that is NOT among the freshly discovered accounts (unknown/stale/out-of-country id).
 */
export function resolveAdsAccountAllowlist(discovered, accountIds) {
  if (!Array.isArray(accountIds) || accountIds.length === 0) {
    throw new Error("Ads-sync account allowlist must be a non-empty array of public account ids (fail closed).");
  }
  const wanted = new Set();
  for (const raw of accountIds) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id) throw new Error("Ads-sync account allowlist contains a blank/non-string id (fail closed).");
    if (wanted.has(id)) throw new Error(`Ads-sync account allowlist contains a duplicate id (fail closed).`);
    if (id.startsWith("dd-secondary:")) {
      throw new Error("Ads-sync account allowlist must not name a dd-secondary account; secondary organizations are never canary targets (fail closed).");
    }
    wanted.add(id);
  }
  const byId = new Map((discovered || []).map((account) => [account.id, account]));
  const selected = [];
  for (const id of wanted) {
    const account = byId.get(id);
    if (!account) throw new Error(`Ads-sync account allowlist id is not among the freshly discovered accounts for this scope (fail closed).`);
    if (!account.connection || account.connection.id !== "primary") {
      throw new Error("Ads-sync account allowlist resolved a non-primary account; refusing (fail closed).");
    }
    selected.push(account);
  }
  // Discovery order (deterministic), not allowlist order.
  return (discovered || []).filter((account) => wanted.has(account.id));
}

// The trusted collaborators runAdsSync's DEPENDENCY-INJECTED core needs. Production wires the real Supabase
// wrappers + the DataDoe network readers here; tests inject deterministic doubles (finding: executable harness
// around a DI core, not a source-text proof). Every I/O touch point is here; the pure helpers stay module-level.
export const PRODUCTION_ADS_SYNC_DEPS = Object.freeze({
  getConnections: getDataDoeConnections,
  fetchAccounts,                 // DataDoe accounts GET (network)
  createExport,                  // ONE DataDoe create-export POST (network)
  downloadExport,                // DataDoe export status-poll + download (network)
  claimRefreshLock,
  releaseRefreshLock,
  getAdsSyncStates,
  getCoverage: getDailyAdsCoverage, // durable coverage/state reader (for the idempotent skip)
  upsertAdsDailyRows,
  deleteAdsDailyRows: deleteAdsDailySourceRows, // clean-replace a window when the export grain changed
  upsertAdDailyMetrics,
  upsertAdsSyncStates,
  recordAdsCoverageWindows,
  now: () => new Date().toISOString(),
  clock: () => Date.now(), // monotonic ms for the work-budget deadline (injectable so the deferral is testable)
});

/**
 * Dependency-injected core of the country Ads sync. Behavior for the existing two-argument callers is
 * unchanged (no options => the normal cadence path). Adds the account-bounded requiredCoverage canary and a
 * lock that is ALWAYS released (try/finally on every post-claim outcome). See runAdsSync for the production
 * entry point. `deps` supplies every I/O collaborator, so this whole function is deterministically testable.
 */
export async function runAdsSyncWithDeps(deps, countries, sourceKeys = ADS_SOURCES.map((source) => source.key), options = {}) {
  const {
    getConnections, fetchAccounts: fetchAccountsDep, createExport: createExportDep, downloadExport: downloadExportDep,
    claimRefreshLock: claimLock, releaseRefreshLock: releaseLock, getCoverage,
    getAdsSyncStates: getStates, upsertAdsDailyRows: upsertRows, upsertAdDailyMetrics: upsertMetrics,
    upsertAdsSyncStates: upsertStates, recordAdsCoverageWindows: recordCoverage, now: nowFn,
  } = deps;
  const clock = typeof deps.clock === "function" ? deps.clock : () => Date.now();
  const deleteRows = typeof deps.deleteAdsDailyRows === "function" ? deps.deleteAdsDailyRows : async () => ({ write: "ok" });

  const now = nowFn();
  const to = now.slice(0, 10);
  const scope = countries === "OTHER" ? "OTHER" : [...countries].sort().join(",");
  const selectedSources = ADS_SOURCES.filter((source) => sourceKeys.includes(source.key));
  if (!selectedSources.length) throw new Error("No supported Ads source was requested.");

  // Validate the BASIC option shape BEFORE claiming the lock (a bad request never holds a lock).
  const { accountIds, requiredCoverage } = validateAdsSyncOptions(options, to);
  const coverageMode = requiredCoverage != null;

  // A requiredCoverage invocation does EXACTLY ONE source's work (one source, one export batch). Reject zero or
  // multiple source keys BEFORE the lock -- zero lock / discovery / DataDoe / Supabase activity on rejection.
  if (coverageMode && ((Array.isArray(sourceKeys) ? sourceKeys.length : 0) !== 1 || selectedSources.length !== 1)) {
    throw new Error("Ads sync requiredCoverage requires EXACTLY one supported sourceKey per invocation (one source, one export batch); fail closed.");
  }

  const lockKey = {
    reportKey: "automated-ads-sync-v1",
    accountId: scope,
    paramsHash: `daily-country-run:${selectedSources.map((source) => source.key).sort().join(",")}`,
  };
  const locked = await claimLock({ ...lockKey, lockSeconds: 600 });
  if (!locked) return { status: "skipped", reason: "A country Ads sync is already running.", scope };

  // EVERY post-claim outcome (success, partial/deadline, discovery failure, allowlist rejection, DataDoe
  // failure, coverage-write failure) releases the lock EXACTLY ONCE via this finally.
  try {
    const connections = getConnections();
    const startedAt = clock();
    let accounts = [];
    const publicAccountIds = new Set();
    for (const connection of connections) {
      const discovered = await fetchAccountsDep(connection.apiKey); // discovery failure throws -> finally releases
      for (const account of discovered) {
        if (!countryMatches(account, countries)) continue;
        const id = publicAccountId(connection, account.id);
        // A raw DataDoe ID is only unique inside its own organisation. Keep a
        // matching secondary ID as a distinct, namespaced sync target.
        if (publicAccountIds.has(id)) continue;
        publicAccountIds.add(id);
        accounts.push({ ...account, rawAccountId: account.id, id, connection });
      }
    }
    // Optional EXACT public-account allowlist (controlled canary, e.g. the Gate-6 PPC prerequisite): select
    // ONLY freshly discovered primary accounts; fail closed on any unknown/duplicate/blank/dd-secondary id
    // (the throw propagates to the finally, releasing the lock). Absent => every discovered account (unchanged).
    if (accountIds != null) accounts = resolveAdsAccountAllowlist(accounts, accountIds);

    const previousStates = await getStates(accounts.map((account) => account.id));
    const states = new Map(previousStates.map((state) => [`${state.account_id}|${state.source_key}`, state]));
    const summary = { status: "completed", scope, accounts: accounts.length, rows: 0, sources: {}, deferred: false };
    if (coverageMode) summary.coverageMode = true;
    // ONE invocation-scoped create-export budget for the whole requiredCoverage run (one source, one batch, so
    // parent + up to two split children). Null in cadence mode => the recursion is unbounded as before.
    const coverageExportBudget = coverageMode ? { count: 0, max: MAX_REQUIRED_COVERAGE_CREATE_EXPORTS } : null;

    for (const source of selectedSources) {
      const work = new Map();
      for (const account of accounts) {
        const previous = states.get(`${account.id}|${source.key}`);
        // coverageMode: NO pickMode -- a bounded canary is one fixed 'coverage' work group per connection and
        // never shortens its window to a cadence mode. Existing ads_sync_state can NEVER downshift the window.
        const mode = coverageMode ? "coverage" : pickMode(previous, source, now);
        // DataDoe API keys are organisation-scoped; a single export must never
        // carry account IDs belonging to two different organisations.
        const workKey = `${account.connection.id}|${mode}`;
        const group = work.get(workKey) || [];
        group.push({ account, previous });
        work.set(workKey, group);
      }
      summary.sources[source.key] = coverageMode
        ? { coverage: 0, skipped: 0, rows: 0, failedAccounts: [], coverageFailedAccounts: [] }
        : { initial: 0, daily: 0, monthly: 0, rows: 0, failedAccounts: [] };

      for (const [workKey, entries] of work) {
        const [, mode] = workKey.split("|");
        for (const batch of chunks(entries, source.batchSize)) {
          if (clock() - startedAt > WORK_BUDGET_MS) {
            // Work-budget deferral -> partial (resumable). Coverage mode gets a TOTAL result via the finalizer.
            if (coverageMode) return finalizeCoverageSummary(summary, { accounts: accounts.length, sourceKeys: selectedSources.map((s) => s.key), deferred: true }); // finally releases the lock
            summary.status = "partial";
            summary.deferred = true;
            return summary; // finally releases the lock
          }
          // EXACT window: coverageMode uses requiredCoverage verbatim for EVERY source; it NEVER calls windowFor.
          const range = coverageMode ? { from: requiredCoverage.from, to: requiredCoverage.to } : windowFor(source, mode, to);
          const connection = batch[0].account.connection;

          // DURABLE IDEMPOTENT COMPLETION (coverage mode): skip an account whose durable coverage ALREADY proves
          // the complete requested [from,to] window AND whose ads_sync_state.last_status is succeeded -- a safely
          // skipped pair counts as SUCCESSFUL and creates ZERO exports. Only the UNCOVERED accounts are exported
          // (never a fully-covered account). A read failure / malformed coverage NEVER authorizes a skip.
          let workingBatch = batch;
          if (coverageMode) {
            const missing = [];
            for (const entry of batch) {
              let covered = false;
              try {
                const cov = await getCoverage(entry.account.id, source.key);
                covered = !!cov && cov.read === "ok" && cov.status === "succeeded"
                  && evaluateSourceCoverage(cov, range.from, range.to).proven === true;
              } catch (_e) { covered = false; }
              if (covered) {
                summary.sources[source.key].coverage += 1;   // safely-skipped pair == successful
                summary.sources[source.key].skipped += 1;
              } else {
                missing.push(entry);
              }
            }
            if (missing.length === 0) continue; // every account already covered -> zero create-exports for this batch
            workingBatch = missing;
          }

          const ids = workingBatch.map((entry) => entry.account.rawAccountId);
          try {
            // FIX 2: the recursive fetch honors the invocation create-export budget (checked before every POST).
            const rows = await fetchAllPages(createExportDep, downloadExportDep, connection.apiKey, source, ids, range.from, range.to, coverageExportBudget);
            // FIX 1: validate the export against the EXACT working batch BEFORE any row/metric/coverage/state
            // write. Any malformed/cross-account/missing-id/wrong-marketplace evidence rejects the WHOLE batch
            // (typed safe failed state only). A genuine zero-row export ([]) is valid covered-empty evidence.
            const evidence = validateExportBatchRows(source, rows, workingBatch, connection);
            if (!evidence.ok) {
              const failed = workingBatch.map(({ account, previous }) => failedStateRecord(account.id, source.key, previous, new Error(`INVALID_EXPORT_EVIDENCE (${evidence.reason})`), now));
              await upsertStates(failed);
              summary.sources[source.key].failedAccounts.push(...workingBatch.map((entry) => entry.account.id));
              continue; // zero row/metric/coverage/success writes for this batch
            }
            const normalized = rows.map((row) => rowRecord(source, row, now, connection));
            // A reduced-grain (aggregated) source must cleanly REPLACE the window per account: any stale rows of a
            // different natural grain (e.g. the old campaign-grain ASIN rows) have different dimension_keys, so an
            // upsert alone would leave them in place and the per-date fold would DOUBLE COUNT. Delete this exact
            // window for each account being persisted, then insert -- only for a source that declares aggregations,
            // so the Campaign/PPC contract (no aggregations) keeps its unchanged upsert-only behavior.
            if (Array.isArray(source.aggregations) && source.aggregations.length) {
              for (const { account } of workingBatch) {
                await deleteRows({ accountId: account.id, sourceKey: source.key, from: range.from, to: range.to });
              }
            }
            // DURABLE Ads-row persistence FIRST -- latest_metric_date + successful state are written only after.
            await upsertRows(normalized);
            if (source.key === "campaign-performance-v1") {
              await upsertMetrics(campaignMetricRecords(normalized));
            }
            const latestDateByAccount = new Map();
            for (const row of normalized) {
              if (!latestDateByAccount.get(row.account_id) || latestDateByAccount.get(row.account_id) < row.metric_date) {
                latestDateByAccount.set(row.account_id, row.metric_date);
              }
            }
            if (coverageMode) {
              // Record the EXACT successful window, then REQUIRE a positive persistence acknowledgement (write ok
              // AND one recorded row per account) BEFORE marking the sync succeeded -- fail closed otherwise.
              const ack = await recordCoverage(workingBatch.map(({ account }) => ({
                accountId: account.id, sourceKey: source.key, coveredFrom: range.from, coveredTo: range.to, sourceRefreshedAt: now,
              })));
              const confirmed = !!ack && ack.write === "ok" && ack.recorded === workingBatch.length;
              if (!confirmed) {
                // Coverage NOT positively confirmed: do NOT advance latest_metric_date or mark succeeded.
                const failed = workingBatch.map(({ account, previous }) => failedStateRecord(account.id, source.key, previous, new Error("COVERAGE_UNCONFIRMED"), now));
                await upsertStates(failed);
                summary.sources[source.key].coverageFailedAccounts.push(...workingBatch.map((entry) => entry.account.id));
                continue;
              }
              // Confirmed: advance latest_metric_date + mark succeeded, PRESERVING cadence timestamps.
              const savedStates = workingBatch.map(({ account, previous }) => coverageStateRecord(account.id, source.key, previous, latestDateByAccount.get(account.id), now));
              await upsertStates(savedStates);
              savedStates.forEach((state) => states.set(`${state.account_id}|${state.source_key}`, state));
              summary.rows += normalized.length;
              summary.sources[source.key].coverage += workingBatch.length;
              summary.sources[source.key].rows += normalized.length;
            } else {
              // NORMAL cadence path -- UNCHANGED behavior. Coverage recording stays best-effort (its return is
              // ignored: a missing/unmigrated table is a safe no-op that must never break a cadence sync).
              const savedStates = workingBatch.map(({ account, previous }) => stateRecord(
                account.id, source.key, previous, mode, latestDateByAccount.get(account.id), now
              ));
              await upsertStates(savedStates);
              await recordCoverage(workingBatch.map(({ account }) => ({
                accountId: account.id, sourceKey: source.key, coveredFrom: range.from, coveredTo: range.to, sourceRefreshedAt: now,
              })));
              savedStates.forEach((state) => states.set(`${state.account_id}|${state.source_key}`, state));
              summary.rows += normalized.length;
              summary.sources[source.key][mode] += workingBatch.length;
              summary.sources[source.key].rows += normalized.length;
            }
          } catch (error) {
            // A DataDoe/persistence failure marks ONLY this working batch's accounts failed; the raw error goes
            // into the durable state record (truncated), NEVER into the returned summary (account ids only). The
            // typed ADS_COVERAGE_EXPORT_BUDGET_EXCEEDED code (fetchRangeWith) also lands here as a safe failure.
            const failed = workingBatch.map(({ account, previous }) => failedStateRecord(account.id, source.key, previous, error, now));
            await upsertStates(failed);
            summary.sources[source.key].failedAccounts.push(...workingBatch.map((entry) => entry.account.id));
          }
        }
      }
    }
    // Coverage mode returns a TOTAL result (completed only when every N x M pair fully succeeded); a normal
    // cadence run returns the unchanged summary (no coverageComplete field -- backward-compatible).
    return coverageMode
      ? finalizeCoverageSummary(summary, { accounts: accounts.length, sourceKeys: selectedSources.map((s) => s.key), deferred: false })
      : summary;
  } finally {
    // Release the lock on EVERY post-claim outcome (never on the 'skipped' path -- that lock belongs to another run).
    await releaseLock(lockKey);
  }
}

/**
 * Production country Ads sync. Thin wrapper over the DI core with the real collaborators. Existing
 * two-argument callers (runAdsSync(countries) / runAdsSync(countries, [sourceKey])) are byte-for-byte
 * behavior-compatible (options default to {} => the normal cadence path).
 */
export async function runAdsSync(countries, sourceKeys = ADS_SOURCES.map((source) => source.key), options = {}) {
  return runAdsSyncWithDeps(PRODUCTION_ADS_SYNC_DEPS, countries, sourceKeys, options);
}
