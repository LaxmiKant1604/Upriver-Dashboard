import {
  claimRefreshLock,
  getAdsSyncStates,
  upsertAdDailyMetrics,
  upsertAdsDailyRows,
  upsertAdsSyncStates,
} from "./supabase.js";
import { getDataDoeConnections, publicAccountId } from "./datadoe-connections.js";

const BASE = "https://api.datadoe.com/api/v1";
const EXPORT_LIMIT = 50000;
const MAX_IDS_PER_EXPORT = 5;
const POLL_DELAY_MS = 5000;
const POLL_ATTEMPTS = 9;
const WORK_BUDGET_MS = 45000;
const MANAGED_COUNTRIES = new Set(["IN", "US", "CA", "AU"]);
const MIN_REQUEST_INTERVAL_MS = 550;
let lastDataDoeRequestAt = 0;

const ADS_SOURCES = [
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
    key: "asin-performance-v1",
    sourceId: "d0017e92fb089c2c8c3fe65f81d08666ecb4fe937ffbce9969ce2fc7d28c805c",
    initialDays: 60,
    dailyDays: 21,
    monthlyDays: 49,
    batchSize: MAX_IDS_PER_EXPORT,
    dimensions: [
      "marketplace_id", "marketplace_country_code", "marketplace_country_name",
      "seller_or_vendor_id", "seller_or_vendor_name", "marketplace_seller_id",
      "amazon_ads_profile_id", "child_asin", "sku", "date", "product_name",
      "ad_campaign_type", "ad_portfolio_id", "ad_portfolio_name", "ad_id",
      "ad_group_id", "ad_campaign_id", "ad_campaign_name", "ad_campaign_status",
      "ad_campaign_budget_amount", "ad_campaign_budget_type", "ad_campaign_budget_currency",
    ],
    metrics: [
      "ad_sales_same_sku", "ad_clicks", "ad_impressions", "ad_spend",
      "ad_units_sold_same_sku", "ad_orders_same_sku",
    ],
    keyFields: ["child_asin", "sku", "ad_campaign_id", "ad_group_id", "ad_id", "ad_campaign_type"],
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

async function createExport(apiKey, source, ids, from, to) {
  const response = await datadoeFetch(`${BASE}/exports`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      sourceId: source.sourceId,
      sellerOrVendorIds: ids,
      columns: [...source.dimensions, ...source.metrics],
      from,
      to,
      limit: EXPORT_LIMIT,
      outputType: "JSON",
      orderByColumn: "date",
      orderByDirection: "ASC",
    }),
  });
  if (!response.ok) {
    throw new Error(`DataDoe ${source.key} export creation failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  }
  return response.json();
}

async function downloadExport(apiKey, exportId) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const status = await datadoeFetch(`${BASE}/exports/${exportId}`, { headers: authHeaders(apiKey) });
    if (!status.ok) throw new Error(`DataDoe export status failed (${status.status}).`);
    const body = await status.json();
    if (body.status === "COMPLETED") break;
    if (["FAILED", "ERROR", "BLOCKED_NO_TOKENS"].includes(body.status)) {
      throw new Error(`DataDoe ${body.status} while exporting Ads data.`);
    }
    if (attempt === POLL_ATTEMPTS - 1) throw new Error("DataDoe Ads export timed out.");
    await sleep(POLL_DELAY_MS);
  }
  const response = await datadoeFetch(`${BASE}/exports/${exportId}/raw`, { headers: authHeaders(apiKey) });
  if (!response.ok) throw new Error(`DataDoe export download failed (${response.status}).`);
  const body = await response.json();
  return typeof body.rawContent === "string" ? JSON.parse(body.rawContent) : (Array.isArray(body) ? body : []);
}

async function fetchRange(apiKey, source, ids, from, to) {
  const created = await createExport(apiKey, source, ids, from, to);
  const rows = await downloadExport(apiKey, created.exportId || created.id);
  if (rows.length < EXPORT_LIMIT) return rows;
  if (from === to) {
    throw new Error(`${source.key} reached the ${EXPORT_LIMIT.toLocaleString("en-US")} row cap for ${from}; the source must be partitioned further before it can be saved safely.`);
  }
  const middle = addDays(from, Math.floor(daysBetween(from, to) / 2));
  const left = await fetchRange(apiKey, source, ids, from, middle);
  const right = await fetchRange(apiKey, source, ids, addDays(middle, 1), to);
  return [...left, ...right];
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
  const metrics = Object.fromEntries(source.metrics.map((key) => [key, row[key] ?? null]));
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
    currency: String(row.currency || row.ad_campaign_budget_currency || ""),
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

export async function runAdsSync(countries, sourceKeys = ADS_SOURCES.map((source) => source.key)) {
  const connections = getDataDoeConnections();
  const now = new Date().toISOString();
  const to = now.slice(0, 10);
  const scope = countries === "OTHER" ? "OTHER" : [...countries].sort().join(",");
  const selectedSources = ADS_SOURCES.filter((source) => sourceKeys.includes(source.key));
  if (!selectedSources.length) throw new Error("No supported Ads source was requested.");
  const locked = await claimRefreshLock({
    reportKey: "automated-ads-sync-v1",
    accountId: scope,
    paramsHash: `daily-country-run:${selectedSources.map((source) => source.key).sort().join(",")}`,
    lockSeconds: 600,
  });
  if (!locked) return { status: "skipped", reason: "A country Ads sync is already running.", scope };

  const startedAt = Date.now();
  const accounts = [];
  const rawAccountOwners = new Map();
  for (const connection of connections) {
    const discovered = await fetchAccounts(connection.apiKey);
    for (const account of discovered) {
      if (!countryMatches(account, countries)) continue;
      const existingConnection = rawAccountOwners.get(account.id);
      if (existingConnection) {
        throw new Error(`Amazon account ${account.id} appears in both ${existingConnection.label} and ${connection.label}. Remove the duplicate DataDoe connection before syncing.`);
      }
      rawAccountOwners.set(account.id, connection);
      accounts.push({
        ...account,
        rawAccountId: account.id,
        id: publicAccountId(connection, account.id),
        connection,
      });
    }
  }
  const previousStates = await getAdsSyncStates(accounts.map((account) => account.id));
  const states = new Map(previousStates.map((state) => [`${state.account_id}|${state.source_key}`, state]));
  const summary = { status: "completed", scope, accounts: accounts.length, rows: 0, sources: {}, deferred: false };

  for (const source of selectedSources) {
    const work = new Map();
    for (const account of accounts) {
      const previous = states.get(`${account.id}|${source.key}`);
      const mode = pickMode(previous, source, now);
      // DataDoe API keys are organisation-scoped; a single export must never
      // carry account IDs belonging to two different organisations.
      const workKey = `${account.connection.id}|${mode}`;
      const group = work.get(workKey) || [];
      group.push({ account, previous });
      work.set(workKey, group);
    }
    summary.sources[source.key] = { initial: 0, daily: 0, monthly: 0, rows: 0, failedAccounts: [] };

    for (const [workKey, entries] of work) {
      const [, mode] = workKey.split("|");
      for (const batch of chunks(entries, source.batchSize)) {
        if (Date.now() - startedAt > WORK_BUDGET_MS) {
          summary.status = "partial";
          summary.deferred = true;
          return summary;
        }
        const range = windowFor(source, mode, to);
        const connection = batch[0].account.connection;
        const ids = batch.map((entry) => entry.account.rawAccountId);
        try {
          const rows = await fetchRange(connection.apiKey, source, ids, range.from, range.to);
          const normalized = rows.map((row) => rowRecord(source, row, now, connection));
          await upsertAdsDailyRows(normalized);
          if (source.key === "campaign-performance-v1") {
            await upsertAdDailyMetrics(campaignMetricRecords(normalized));
          }
          const latestDateByAccount = new Map();
          for (const row of normalized) {
            if (!latestDateByAccount.get(row.account_id) || latestDateByAccount.get(row.account_id) < row.metric_date) {
              latestDateByAccount.set(row.account_id, row.metric_date);
            }
          }
          const savedStates = batch.map(({ account, previous }) => stateRecord(
            account.id, source.key, previous, mode, latestDateByAccount.get(account.id), now
          ));
          await upsertAdsSyncStates(savedStates);
          savedStates.forEach((state) => states.set(`${state.account_id}|${state.source_key}`, state));
          summary.rows += normalized.length;
          summary.sources[source.key][mode] += batch.length;
          summary.sources[source.key].rows += normalized.length;
        } catch (error) {
          const failed = batch.map(({ account, previous }) => failedStateRecord(account.id, source.key, previous, error, now));
          await upsertAdsSyncStates(failed);
          summary.sources[source.key].failedAccounts.push(...batch.map((entry) => entry.account.id));
        }
      }
    }
  }
  return summary;
}
