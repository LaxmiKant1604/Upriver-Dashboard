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

import { canonicalCurrency, adsCurrencyEvidence } from "../currency.js";
import { addDaysStr, num, canonicalOliSlices } from "../datadoe.js";
import { getAdsDailySourceRows, getAdsSyncStates } from "../supabase.js";
import { brandLabel, fetchCatalog, fetchExportRowsStrict, sumField } from "./common.js";
import { isCancelledStatus } from "../sync/oli-order-rules.js";
import { ADS_ASIN, ADS_CAMPAIGN, ADS_SEARCH_TERMS, ADS_TARGETING, OLI_ROW_LIMIT, ORDER_LINE_ITEMS, ROW_LIMITS } from "./sources.js";

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

// TACoS denominator = total ordered sales from the ONE CANONICAL Order Line Items sales fragment
// (Blocker 1), grouped by [date, seller_or_vendor_id, sku, child_asin, item_price_currency] so DataDoe
// never sums money across currencies and this export is byte-identical to the other OLI reports (shared
// request_hashes on overlapping calendar-anchored slices => one export, many owners). The fold sums
// item_price_value per currency; TACoS validates that the single currency present equals the Ads currency.
const OLI_SALES_GROUP_BY = ["date", "seller_or_vendor_id", "sku", "child_asin", "item_price_currency", "amazon_order_status", "fulfillment_channel", "address_state", "address_city", "amazon_order_id", "item_status"];
const OLI_SALES_AGGREGATIONS = [
  { column: "item_price_value", aggregation: "sum", alias: "total_sales_sum" },
  { column: "quantity", aggregation: "sum", alias: "total_units_sum" },
];
// The account total-sales denominator must be in the SAME currency as the Ads spend.
// The ads-currency gate upstream guarantees <=1 Ads currency; when the Order Line Items
// rows carry a different currency (or mix), TACoS degrades rather than summing across them.
const TOTAL_SALES_CURRENCY_MISMATCH_REASON =
  "TACoS is unavailable because the account total-sales are in a different currency than the Ads spend; a combined total-sales denominator would be meaningless.";
// More than ONE distinct VALID canonical Ads currency: a combined total-sales denominator across two live
// currencies would be meaningless. Named as a const (kept byte-identical to report-derivation.js's
// PPC_MULTI_CURRENCY_REASON) so this string can never drift between the live builder and the scheduler derive.
const PPC_MULTI_CURRENCY_REASON =
  "TACoS is unavailable because this account's saved Ads rows use multiple currencies. A combined total-sales denominator would be meaningless.";

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
    const currency = canonicalCurrency(row.currency);
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

export async function buildPpcPerformance({ apiKey, ids, accountId: publicAccountId = ids[0], to }, deps = {}) {
  // `ids` stays raw for the live DataDoe sales export. Persisted Ads rows use
  // the public account ID so a secondary DataDoe organisation cannot collide
  // with the primary organisation's stored history.
  const accountId = publicAccountId;
  const from = addDaysStr(to, -(WINDOW_DAYS - 1));

  // Minimal DI seam: production callers pass no second arg, so each resolves to the real transport
  // (unchanged behaviour). Tests inject stubs to exercise the OLI transport-ordering gate offline.
  const getAdsSyncStatesFn = deps.getAdsSyncStates || getAdsSyncStates;
  const getAdsDailySourceRowsFn = deps.getAdsDailySourceRows || getAdsDailySourceRows;
  // The OLI total-sales denominator is a STRICT-transport source: the production default routes through the
  // shared fetchExportRowsStrict (whose rows.length >= limit cap guard makes a truncated page fail closed).
  // Kept as a thin forwarder so the strict transport is genuinely invoked by default yet still injectable.
  const fetchExportRowsStrictFn = deps.fetchExportRowsStrict || ((...args) => fetchExportRowsStrict(...args));
  const fetchCatalogFn = deps.fetchCatalog || fetchCatalog;

  // Sync state first: it is what lets the report say "the worker has not seeded
  // this account yet" instead of rendering zeroes as if spend were really zero.
  const syncStates = await getAdsSyncStatesFn([accountId]);
  const syncByKey = new Map(syncStates.map((state) => [state.source_key, state]));

  const adsRows = await getAdsDailySourceRowsFn({
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
    const currency = canonicalCurrency(row.currency);
    const key = `${date}|${currency || "?"}`;
    const entry = dailyMap.get(key) || { date, currency, ...emptyTotals() };
    accumulate(entry, row, "ad_sales", "ad_orders", "ad_units_sold");
    dailyMap.set(key, entry);
  }
  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  // TACoS needs total account sales, which no Ads table carries. One small
  // grouped export, on explicit refresh only, saved into the shared snapshot.
  //
  // usd/USD consistency: CLASSIFY the Ads currency evidence ONCE, up front, via the SHARED canonical
  // adsCurrencyEvidence -- the SAME 4-state classifier the scheduler planner gate (evaluateAdsCurrencyGate),
  // the pure ppcPerformancePayload fold, and the derive adapter use -- so "usd" + "USD" canonicalize to ONE
  // currency (state "single-valid") HERE exactly as they do in the planner, instead of a raw case-sensitive
  // Set counting them as two and skipping the OLI slices the planner already scheduled. This gate is entered
  // BEFORE any canonicalOliSlices/fetchExportRowsStrict call, so the non-single-valid states make ZERO OLI calls.
  const adsEvidence = adsCurrencyEvidence(adsRows);
  // Payload currency identities are canonicalized too, so "usd" + "USD" collapse to ["USD"] (never ["USD","usd"])
  // and the UI's multi-currency KPI suppression no longer false-positives on mere casing.
  const currencies = [...new Set(adsRows.map((row) => canonicalCurrency(row.currency)).filter(Boolean))].sort();
  let totalSales = null;
  let totalSalesUnavailable = null;
  if (adsEvidence.state === "multiple") {
    // > 1 distinct VALID canonical Ads currency: a combined denominator is meaningless. ZERO OLI calls.
    totalSalesUnavailable = PPC_MULTI_CURRENCY_REASON;
  } else if (adsEvidence.state !== "single-valid") {
    // "empty" (no Ads rows) or "invalid" (any blank/absent/malformed like "US D"): fail closed BEFORE spending
    // any OLI export -- the fetch loop is NEVER entered, exactly ZERO fetchExportRowsStrict calls.
    totalSalesUnavailable = TOTAL_SALES_CURRENCY_MISMATCH_REASON;
  } else {
    // state "single-valid": the persisted Ads rows carry ONE proven canonical currency. Enter the OLI loop.
    const adsCurrency = adsEvidence.currency;
    try {
      // The ONE canonical OLI sales fragment over [from, to], sliced by canonicalOliSlices so its interior +
      // asOf-boundary slices share request_hashes with the other OLI reports (one export, many owners).
      const salesRows = [];
      for (const slice of canonicalOliSlices(from, to)) {
        const sliceRows = await fetchExportRowsStrictFn(
          apiKey, ORDER_LINE_ITEMS.id, OLI_SALES_GROUP_BY, ids, slice.from, slice.to, OLI_ROW_LIMIT,
          {
            groupBy: OLI_SALES_GROUP_BY,
            aggregations: OLI_SALES_AGGREGATIONS,
            orderByColumn: "date",
            orderByDirection: "ASC",
          },
          `PPC total-sales export (${slice.from} to ${slice.to})`
        );
        // The canonical OLI fragment now carries amazon_order_status: CANCELLED / CANCELED orders contribute ZERO
        // to total sales (the TACoS denominator); the authoritative missing-status refusal is in the evidence layer.
        for (const row of sliceRows) {
          if (isCancelledStatus(row.amazon_order_status)) continue;
          salesRows.push(row);
        }
      }
      // The Ads currency is now a proven single valid canonical code: TACoS sums ONLY when every OLI
      // total-sales row's canonicalCurrency(item_price_currency) is non-null AND EQUAL to it. Any
      // missing/blank/malformed/mismatched OLI currency leaves TACoS unavailable and NO row is summed
      // (never sum a currencyless/ambiguous row into a currency denominator).
      if (!salesRows.every((row) => canonicalCurrency(row.item_price_currency) === adsCurrency)) {
        totalSalesUnavailable = TOTAL_SALES_CURRENCY_MISMATCH_REASON;
      } else {
        totalSales = salesRows.reduce((sum, row) => sum + sumField(row, "total_sales_sum", "item_price_value"), 0);
      }
    } catch (error) {
      // TACoS is the only metric that needs this. Losing it must not lose the
      // whole report, so it degrades to "unavailable" rather than throwing.
      totalSalesUnavailable = error instanceof Error ? error.message : String(error);
    }
  }

  const catalog = await fetchCatalogFn(apiKey, ids);
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
    totalSalesSourceLabel: ORDER_LINE_ITEMS.label,
    totalSalesLagDays: ORDER_LINE_ITEMS.lagDays,
    currencies,
    daily,
    campaigns,
    asins,
    targets,
    searchTerms,
    catalogBrands: catalog.catalogBrands,
  };
}
