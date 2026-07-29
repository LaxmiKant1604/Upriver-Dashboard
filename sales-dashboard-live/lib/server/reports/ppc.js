// PPC Performance & Wasted Spend.
//
// The advertising numbers in this report come ENTIRELY from the persisted
// Supabase Ads history that the scheduled worker maintains. Opening this report,
// switching level, filtering, sorting or refreshing never runs an Amazon Ads
// export, so no amount of dashboard traffic can burn DataDoe Ads quota. The
// worker keeps late attribution correct by re-fetching each source's documented
// rolling window and upserting on its natural daily key, so a value that Amazon
// revises is replaced rather than double-counted.
//
// Ad-product coverage, which the UI must not misstate:
//   * Campaign and ASIN levels cover every campaign type present in the account.
//   * Keyword Targeting Performance is SP + SB + SD.
//   * Search Term Performance is SP + SB only — never Sponsored Display.
// `ad_campaign_type` is preserved on every row so this stays visible.
//
// The one DataDoe call this report makes is a single small grouped export of
// account total sales, which is required for TACoS and cannot come from an Ads
// table. It runs on explicit refresh only and is saved into the shared snapshot.

import { addDaysStr, num } from "../datadoe.js";
import { getAdsDailySourceRows, getAdsSyncStates } from "../supabase.js";
import { brandLabel, fetchCatalog, fetchExportRowsStrict, sumField } from "./common.js";
import { ADS_ASIN, ADS_CAMPAIGN, ADS_SEARCH_TERMS, ADS_TARGETING, ROW_LIMITS, SALES_TRAFFIC } from "./sources.js";

export const PPC_REPORT_KEY = "ppc-performance";
export const PPC_VERSION = "ppc-performance-v1";

const WINDOW_DAYS = 30;
const MAX_ADS_ROWS = 120000;
// Below this many clicks a zero-order term is not yet evidence of waste, it is
// just a small sample. Matches the DataDoe watchdog blueprint.
const MIN_CLICKS_FOR_WASTE = 10;

const SOURCE_KEYS = [
  ADS_CAMPAIGN.syncKey,
  ADS_ASIN.syncKey,
  ADS_TARGETING.syncKey,
  ADS_SEARCH_TERMS.syncKey,
];

const TOTAL_SALES_GROUP_BY = ["date"];
const TOTAL_SALES_AGGREGATIONS = [
  { column: "total_sales", aggregation: "sum", alias: "sales_sum" },
  { column: "total_units", aggregation: "sum", alias: "units_sum" },
];

function metric(row, key) {
  return num(row.metrics?.[key]);
}

function emptyTotals() {
  return { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0, units: 0 };
}

function accumulate(target, row, salesKey, ordersKey, unitsKey) {
  target.spend += metric(row, "ad_spend");
  target.sales += metric(row, salesKey);
  target.clicks += metric(row, "ad_clicks");
  target.impressions += metric(row, "ad_impressions");
  target.orders += metric(row, ordersKey);
  target.units += metric(row, unitsKey);
  return target;
}

/**
 * Fold one Ads source into keyed buckets.
 *
 * Every bucket keeps `campaignTypes` so the UI can show which ad products a row
 * actually represents instead of implying full SP+SB+SD coverage.
 */
export function rollupPpcRows(rows, keyFn, labelFn, { salesKey, ordersKey, unitsKey }) {
  const byKey = new Map();
  for (const row of rows) {
    const entityKey = keyFn(row);
    if (entityKey === null || entityKey === undefined || entityKey === "") continue;
    // A campaign, target, or search term can only be summed with rows in the
    // same currency. Including currency in the storage key prevents a
    // multi-marketplace account from displaying INR + USD as one amount.
    const currency = String(row.currency || "").trim() || null;
    const key = `${currency || "?"}|${entityKey}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        key,
        ...labelFn(row),
        ...emptyTotals(),
        currencies: new Set(),
        campaignTypes: new Set(),
        days: new Set(),
      };
      byKey.set(key, entry);
    }
    accumulate(entry, row, salesKey, ordersKey, unitsKey);
    if (currency) entry.currencies.add(currency);
    if (row.campaign_type) entry.campaignTypes.add(row.campaign_type);
    if (row.metric_date) entry.days.add(row.metric_date);
  }
  return [...byKey.values()].map(({ currencies, campaignTypes, days, ...entry }) => ({
    ...entry,
    currencies: [...currencies].sort(),
    campaignTypes: [...campaignTypes].sort(),
    activeDays: days.size,
  }));
}

export async function buildPpcPerformance({ apiKey, ids, to }) {
  const accountId = ids[0];
  const from = addDaysStr(to, -(WINDOW_DAYS - 1));

  // Sync state first: it is what lets the report say "the worker has not seeded
  // this account yet" instead of rendering zeroes as if spend were really zero.
  const syncStates = await getAdsSyncStates([accountId]);
  const syncByKey = new Map(syncStates.map((state) => [state.source_key, state]));

  const adsRows = await getAdsDailySourceRows({
    accountId, sourceKeys: SOURCE_KEYS, from, to, maxRows: MAX_ADS_ROWS,
  });

  const bySource = new Map(SOURCE_KEYS.map((key) => [key, []]));
  for (const row of adsRows) {
    const bucket = bySource.get(row.source_key);
    if (bucket) bucket.push(row);
  }

  const campaignRows = bySource.get(ADS_CAMPAIGN.syncKey) || [];
  const asinRows = bySource.get(ADS_ASIN.syncKey) || [];
  const targetingRows = bySource.get(ADS_TARGETING.syncKey) || [];
  const searchTermRows = bySource.get(ADS_SEARCH_TERMS.syncKey) || [];

  // Campaign performance uses account-level ad_sales / ad_orders.
  const campaigns = rollupPpcRows(
    campaignRows,
    (row) => `${row.campaign_id}|${row.campaign_type}`,
    (row) => ({
      campaignId: row.campaign_id || null,
      campaignName: row.dimensions?.ad_campaign_name || null,
      campaignType: row.campaign_type || null,
      campaignStatus: row.dimensions?.ad_campaign_status || null,
      portfolioName: row.dimensions?.ad_portfolio_name || null,
      budgetAmount: row.dimensions?.ad_campaign_budget_amount ?? null,
      budgetType: row.dimensions?.ad_campaign_budget_type || null,
    }),
    { salesKey: "ad_sales", ordersKey: "ad_orders", unitsKey: "ad_units_sold" }
  );

  // ASIN performance is same-SKU attributed in this source; the aliases make
  // that explicit rather than presenting it as total attributed sales.
  const asins = rollupPpcRows(
    asinRows,
    (row) => row.child_asin,
    (row) => ({
      asin: row.child_asin || null,
      sku: row.dimensions?.sku || null,
      productName: row.dimensions?.product_name || null,
    }),
    { salesKey: "ad_sales_same_sku", ordersKey: "ad_orders_same_sku", unitsKey: "ad_units_sold_same_sku" }
  );

  const targets = rollupPpcRows(
    targetingRows,
    (row) => `${row.targeting_id || row.dimensions?.ad_keyword_id || ""}|${row.campaign_id}|${row.dimensions?.ad_group_id || ""}`,
    (row) => ({
      targetText: row.dimensions?.ad_targeting_text || row.dimensions?.ad_keyword || null,
      matchType: row.dimensions?.ad_match_type || null,
      keywordStatus: row.dimensions?.ad_keyword_status || null,
      campaignId: row.campaign_id || null,
      campaignName: row.dimensions?.ad_campaign_name || null,
      campaignType: row.campaign_type || null,
      adGroupName: row.dimensions?.ad_group_name || null,
    }),
    { salesKey: "ad_sales", ordersKey: "ad_orders", unitsKey: "ad_units_sold_click" }
  );

  const searchTerms = rollupPpcRows(
    searchTermRows,
    (row) => `${row.dimensions?.ad_search_term || ""}|${row.campaign_id}|${row.dimensions?.ad_group_id || ""}`,
    (row) => ({
      searchTerm: row.dimensions?.ad_search_term || null,
      matchedKeyword: row.dimensions?.ad_keyword || row.dimensions?.ad_targeting_text || null,
      matchType: row.dimensions?.ad_match_type || null,
      campaignId: row.campaign_id || null,
      campaignName: row.dimensions?.ad_campaign_name || null,
      campaignType: row.campaign_type || null,
      adGroupName: row.dimensions?.ad_group_name || null,
    }),
    { salesKey: "ad_sales", ordersKey: "ad_orders", unitsKey: "ad_units_sold_click" }
  );

  // Daily account series, for the trend and for the account KPI row.
  const dailyMap = new Map();
  for (const row of campaignRows) {
    const date = row.metric_date;
    if (!date) continue;
    const currency = String(row.currency || "").trim() || null;
    const key = `${date}|${currency || "?"}`;
    const entry = dailyMap.get(key) || { date, currency, ...emptyTotals() };
    accumulate(entry, row, "ad_sales", "ad_orders", "ad_units_sold");
    dailyMap.set(key, entry);
  }
  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  // TACoS needs total account sales, which no Ads table carries. One small
  // grouped export, on explicit refresh only, saved into the shared snapshot.
  const currencies = [...new Set(adsRows.map((row) => row.currency).filter(Boolean))].sort();
  let totalSales = null;
  let totalSalesUnavailable = null;
  if (currencies.length > 1) {
    totalSalesUnavailable = "TACoS is unavailable because this account's saved Ads rows use multiple currencies. A combined total-sales denominator would be meaningless.";
  } else {
    try {
      const salesRows = await fetchExportRowsStrict(
        apiKey, SALES_TRAFFIC.id, TOTAL_SALES_GROUP_BY, ids, from, to, ROW_LIMITS.dateRollup,
        {
          groupBy: TOTAL_SALES_GROUP_BY,
          aggregations: TOTAL_SALES_AGGREGATIONS,
          orderByColumn: "date",
          orderByDirection: "ASC",
        },
        "PPC total-sales export"
      );
      totalSales = salesRows.reduce((sum, row) => sum + sumField(row, "sales_sum", "total_sales"), 0);
    } catch (error) {
      // TACoS is the only metric that needs this. Losing it must not lose the
      // whole report, so it degrades to "unavailable" rather than throwing.
      totalSalesUnavailable = error instanceof Error ? error.message : String(error);
    }
  }

  const catalog = await fetchCatalog(apiKey, ids);
  for (const row of asins) {
    const meta = row.asin ? catalog.byAsin.get(row.asin) || {} : {};
    row.productName = row.productName || meta.name || null;
    row.brand = brandLabel(meta.brand);
  }

  const latestMetricDate = adsRows.reduce(
    (latest, row) => (!latest || row.metric_date > latest ? row.metric_date : latest),
    null
  );

  return {
    accountId,
    asOf: to,
    window: { from, to, days: WINDOW_DAYS },
    adsSourceOrigin: "Persisted Supabase Amazon Ads history maintained by the scheduled worker",
    minClicksForWaste: MIN_CLICKS_FOR_WASTE,
    // Availability, so an unseeded account is reported honestly.
    adsRowCount: adsRows.length,
    latestMetricDate,
    sourceAvailability: [
      { key: ADS_CAMPAIGN.syncKey, label: ADS_CAMPAIGN.label, coverage: "All campaign types present in the account", rows: campaignRows.length, sync: syncByKey.get(ADS_CAMPAIGN.syncKey) || null, defaultDataset: true },
      { key: ADS_ASIN.syncKey, label: ADS_ASIN.label, coverage: "Same-SKU attributed metrics", rows: asinRows.length, sync: syncByKey.get(ADS_ASIN.syncKey) || null, defaultDataset: true },
      { key: ADS_TARGETING.syncKey, label: ADS_TARGETING.label, coverage: ADS_TARGETING.coverage, rows: targetingRows.length, sync: syncByKey.get(ADS_TARGETING.syncKey) || null, defaultDataset: false, enableHint: ADS_TARGETING.enableHint },
      { key: ADS_SEARCH_TERMS.syncKey, label: ADS_SEARCH_TERMS.label, coverage: ADS_SEARCH_TERMS.coverage, rows: searchTermRows.length, sync: syncByKey.get(ADS_SEARCH_TERMS.syncKey) || null, defaultDataset: false, enableHint: ADS_SEARCH_TERMS.enableHint },
    ],
    totalSales,
    totalSalesUnavailable,
    totalSalesSourceLabel: SALES_TRAFFIC.label,
    totalSalesLagDays: SALES_TRAFFIC.lagDays,
    currencies,
    daily,
    campaigns,
    asins,
    targets,
    searchTerms,
    catalogBrands: catalog.catalogBrands,
  };
}
