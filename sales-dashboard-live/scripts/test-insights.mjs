// Focused tests for the Insight Engine.
//
// These cover the parts that are easy to get subtly wrong and expensive to get
// wrong in front of a user: the exactness of the sales decomposition, the
// refusal to average ratios, the "never claim an unevidenced cause" rule, the
// ranking, the dedupe, and the CSV formula-injection guard.
//
// Run with: npm run test:insights

import assert from "node:assert/strict";

import {
  buildBuyBoxRows,
  buildListingHealthRows,
  buildSalesMoversRows,
  buildSalesMoversInsights,
  buildBuyBoxInsights,
  decomposeSalesChange,
  dedupeInsights,
  insightExportRows,
  makeInsight,
  TITLE_MAX_CHARS,
  auditTitle,
  buildOptimizerInsights,
  buildOptimizerRows,
  buildPpcInsights,
  buildPpcRows,
  classifyOptimizerQuery,
  optimizerQueryMetrics,
  buildReturnsInsights,
  buildReturnsRows,
  returnsPortfolioRate,
  ppcMetrics,
  salesMoversCompletenessWarning,
  sortInsights,
} from "../src/lib/insights.js";
// The reason-bucket classifier runs server-side (the client receives rows that
// are already bucketed), so it is imported from the report builder.
import { classifyReturnReason } from "../lib/server/reports/returns.js";
import { rollupPpcRows } from "../lib/server/reports/ppc.js";
import { staleSnapshotMatchesReportVersion } from "../lib/server/report-store.js";
import {
  decorateDataDoeAccount,
  mergeDiscoveredDataDoeAccounts,
  publicAccountId,
  resolveDataDoeAccountIds,
  scopeDataDoeRows,
} from "../lib/server/datadoe-connections.js";
import { marketplaceProfile, marketplaceToday } from "../lib/marketplaces.js";
import { csvCell, csvText } from "../src/lib/csv.js";
import { fmtMoney, nInt, ratio } from "../src/lib/format.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    console.error(error.message);
    process.exitCode = 1;
  }
}

console.log("Insight Engine");

/* ---------- multi-DataDoe account routing ---------- */

const TEST_CONNECTIONS = [
  { id: "primary", label: "Primary DataDoe", apiKey: "primary-key", accountPrefix: "" },
  { id: "secondary", label: "Secondary DataDoe", apiKey: "secondary-key", accountPrefix: "dd-secondary:" },
];

test("primary DataDoe accounts keep their existing public IDs", () => {
  assert.equal(publicAccountId(TEST_CONNECTIONS[0], "seller-1"), "seller-1");
  const account = decorateDataDoeAccount(TEST_CONNECTIONS[0], { id: "seller-1", name: "Primary Store" });
  assert.equal(account.id, "seller-1");
  assert.equal(account.name, "Primary Store");
});

test("secondary DataDoe rows and accounts are safely namespaced", () => {
  const account = decorateDataDoeAccount(TEST_CONNECTIONS[1], { id: "seller-1", name: "Secondary Store" });
  assert.equal(account.id, "dd-secondary:seller-1");
  assert.match(account.name, /Secondary DataDoe/);
  const rows = scopeDataDoeRows(TEST_CONNECTIONS[1], [{ seller_or_vendor_id: "seller-1", total_sales: 10 }]);
  assert.equal(rows[0].seller_or_vendor_id, "dd-secondary:seller-1");
});

test("account discovery retains matching raw IDs from both DataDoe organisations", () => {
  const accounts = mergeDiscoveredDataDoeAccounts([
    { connection: TEST_CONNECTIONS[0], accounts: [{ id: "seller-1", name: "Primary Store" }] },
    { connection: TEST_CONNECTIONS[1], accounts: [{ id: "seller-1", name: "Secondary Store" }] },
  ]);
  assert.deepEqual(accounts.map((account) => account.id), ["seller-1", "dd-secondary:seller-1"]);
  assert.equal(accounts[1].name, "Secondary Store (Secondary DataDoe)");
});

test("DataDoe exports reject mixed-organisation account IDs", () => {
  const secondary = resolveDataDoeAccountIds(["dd-secondary:seller-2"], TEST_CONNECTIONS);
  assert.equal(secondary.connection.id, "secondary");
  assert.deepEqual(secondary.rawAccountIds, ["seller-2"]);
  assert.throws(
    () => resolveDataDoeAccountIds(["seller-1", "dd-secondary:seller-2"], TEST_CONNECTIONS),
    /Cross-organisation exports/
  );
});

/* ---------- decomposition ---------- */

test("sales decomposition sums exactly to the sales change", () => {
  const cases = [
    [{ sessions: 1200, units: 90, sales: 4500 }, { sessions: 1000, units: 100, sales: 5200 }],
    [{ sessions: 10, units: 1, sales: 19.99 }, { sessions: 400, units: 40, sales: 812.4 }],
    [{ sessions: 7777, units: 1234, sales: 98765.43 }, { sessions: 1, units: 1, sales: 1 }],
  ];
  for (const [recent, prior] of cases) {
    const parts = decomposeSalesChange(recent, prior);
    assert.ok(parts, "expected a decomposition");
    const total = parts.traffic + parts.conversion + parts.price;
    const actual = recent.sales - prior.sales;
    // Floating point only, not a tolerance for a wrong formula.
    assert.ok(Math.abs(total - actual) < 1e-6, `parts ${total} != change ${actual}`);
  }
});

test("decomposition refuses to attribute when a denominator is missing", () => {
  assert.equal(decomposeSalesChange({ sessions: 0, units: 0, sales: 0 }, { sessions: 100, units: 10, sales: 500 }), null);
  assert.equal(decomposeSalesChange({ sessions: 100, units: 10, sales: 500 }, { sessions: 100, units: 0, sales: 0 }), null);
});

/* ---------- Sales Movers ---------- */

const moversData = {
  accountId: "acct-1",
  salesLatestDate: "2026-07-25",
  lagDays: 4,
  sourceLabel: "Sales & Traffic by ASIN & Date",
  dataUnavailable: false,
  inventoryAvailable: true,
  inventorySnapshotDate: "2026-07-29",
  windows: { recent: { from: "2026-07-19", to: "2026-07-25" }, prior: { from: "2026-07-12", to: "2026-07-18" } },
  currencies: ["INR"],
  rows: [
    {
      asin: "B001", productName: "Falling ASIN", brand: "Alpha",
      recent: { sales: 4000, units: 80, orders: 78, sessions: 1000, pageViews: 1200 },
      prior: { sales: 8000, units: 160, orders: 155, sessions: 2000, pageViews: 2400 },
      ads: { recentSpend: 100, recentSales: 300, priorSpend: 400, priorSales: 1200 },
      inventory: { available: 50, inbound: 0, daysOfSupply: 12, unitsShippedT30: 300 },
    },
    {
      asin: "B002", productName: "Stocked out ASIN", brand: "Alpha",
      recent: { sales: 2000, units: 40, orders: 40, sessions: 500, pageViews: 600 },
      prior: { sales: 2100, units: 42, orders: 42, sessions: 520, pageViews: 640 },
      ads: { recentSpend: 0, recentSales: 0, priorSpend: 0, priorSales: 0 },
      inventory: { available: 0, inbound: 0, daysOfSupply: 0, unitsShippedT30: 120 },
    },
    {
      asin: "B003", productName: "Other brand", brand: "Beta",
      recent: { sales: 900, units: 9, orders: 9, sessions: 300, pageViews: 320 },
      prior: { sales: 300, units: 3, orders: 3, sessions: 100, pageViews: 110 },
      ads: { recentSpend: 10, recentSales: 90, priorSpend: 5, priorSales: 20 },
      inventory: { available: 80, inbound: 20, daysOfSupply: 40, unitsShippedT30: 30 },
    },
  ],
};

test("the shared header brand filter is applied locally", () => {
  assert.equal(buildSalesMoversRows(moversData, "ALL").length, 3);
  const alpha = buildSalesMoversRows(moversData, "Alpha");
  assert.equal(alpha.length, 2);
  assert.ok(alpha.every((row) => row.brand === "Alpha"));
});

test("conversion and price are recomputed from totals, never averaged", () => {
  const [row] = buildSalesMoversRows(moversData, "ALL");
  assert.equal(row.cvrRecent, 80 / 1000);
  assert.equal(row.aspRecent, 4000 / 80);
  // Traffic halved while conversion and price held, so traffic must dominate.
  assert.equal(row.dominantDriver, "traffic");
  assert.equal(row.salesDelta, -4000);
});

test("a zero-stock ASIN that sold produces a high-severity stockout insight", () => {
  const rows = buildSalesMoversRows(moversData, "ALL");
  const insights = buildSalesMoversInsights(moversData, rows, "INR");
  const stockout = insights.find((insight) => insight.category === "stockout");
  assert.ok(stockout, "expected a stockout insight");
  assert.equal(stockout.asin, "B002");
  assert.equal(stockout.moneyAtRisk, 2000);
  assert.equal(stockout.currency, "INR");
  assert.equal(stockout.confidence, "high");
  assert.ok(stockout.action.length > 10);
  assert.ok(stockout.evidence.length >= 3);
});

test("every insight carries severity, evidence, why, action and freshness", () => {
  const rows = buildSalesMoversRows(moversData, "ALL");
  for (const insight of buildSalesMoversInsights(moversData, rows, "INR")) {
    assert.ok(["high", "medium", "low"].includes(insight.severity), "severity");
    assert.ok(insight.evidence.length > 0, "evidence");
    assert.ok(insight.why && insight.why.length > 10, "why");
    assert.ok(insight.action && insight.action.length > 10, "action");
    assert.ok(insight.freshness, "freshness");
    assert.ok(["high", "medium", "low"].includes(insight.confidence), "confidence");
  }
});

test("an unattributable decline says so and drops confidence", () => {
  const data = {
    ...moversData,
    rows: [{
      asin: "B009", productName: "No sessions last week", brand: "Alpha",
      recent: { sales: 0, units: 0, orders: 0, sessions: 0, pageViews: 0 },
      prior: { sales: 5000, units: 50, orders: 50, sessions: 900, pageViews: 1000 },
      ads: { recentSpend: 0, recentSales: 0, priorSpend: 0, priorSales: 0 },
      inventory: null,
    }],
  };
  const rows = buildSalesMoversRows(data, "ALL");
  assert.equal(rows[0].dominantDriver, null);
  const insight = buildSalesMoversInsights(data, rows, "INR").find((item) => item.category === "decline-unattributed");
  assert.ok(insight, "expected an unattributed decline insight");
  assert.equal(insight.confidence, "low");
  assert.ok(/cannot be attributed/i.test(insight.why));
});

test("a uniform traffic-shaped collapse is reported as possible incompleteness", () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    asin: `Z${index}`, productName: `Z${index}`, brand: "Alpha",
    recent: { sales: 100, units: 2, orders: 2, sessions: 20, pageViews: 25 },
    prior: { sales: 1000, units: 20, orders: 20, sessions: 200, pageViews: 250 },
    ads: { recentSpend: 0, recentSales: 0, priorSpend: 0, priorSales: 0 },
    inventory: null,
  }));
  const built = buildSalesMoversRows({ ...moversData, rows }, "ALL");
  const warning = salesMoversCompletenessWarning(built);
  assert.ok(warning && /not finished loading/i.test(warning));
  // A healthy mixed set must NOT trigger the guard.
  assert.equal(salesMoversCompletenessWarning(buildSalesMoversRows(moversData, "ALL")), null);
});

test("advertising figures are withheld for an ASIN reporting two currencies", () => {
  // The advertising export is grouped by child_asin AND currency, so folding to
  // ASIN alone would add rupees to dollars. The server marks such an ASIN and
  // the client must show no number rather than a meaningless one.
  const data = {
    ...moversData,
    currencies: ["INR", "USD"],
    rows: [{
      asin: "B00MIX", productName: "Dual currency ASIN", brand: "Alpha",
      recent: { sales: 1000, units: 20, orders: 20, sessions: 400, pageViews: 450 },
      prior: { sales: 2000, units: 40, orders: 40, sessions: 800, pageViews: 900 },
      ads: {
        recentSpend: null, recentSales: null, recentClicks: null,
        priorSpend: null, priorSales: null, priorClicks: null,
        currency: null, mixedCurrency: true,
      },
      inventory: null,
    }],
  };
  const [row] = buildSalesMoversRows(data, "ALL");
  assert.equal(row.adsMixedCurrency, true);
  assert.equal(row.adSpendDelta, null, "must not report a cross-currency spend delta");
  assert.equal(row.adSalesDelta, null);
  // The sales decomposition is unaffected: Sales & Traffic has no currency and
  // is always in the account currency.
  assert.equal(row.salesDelta, -1000);
  assert.equal(row.dominantDriver, "traffic");
});

/* ---------- Listing Health ---------- */

const listingData = {
  accountId: "acct-1",
  asOf: "2026-07-29",
  salesWindow: { from: "2026-06-30", to: "2026-07-29", days: 30 },
  sourceLabel: "Listings",
  salesSourceLabel: "Profit by SKU & Date",
  issuesAvailable: true,
  issuesSourceLabel: "Listings (Raw JSON)",
  inventoryAvailable: true,
  currencies: ["INR"],
  rows: [
    {
      sku: "SKU-ERR", asin: "B100", productName: "Blocked by error", brand: "Alpha",
      listingStatus: "Active", fulfillmentChannel: "FBA", price: 499, currency: "INR",
      listingQuantity: 0, fbaAvailable: 10, snapshotAvailable: 10,
      sales30d: 15000, units30d: 30, hasSalesData: true,
      issues: [{ severity: "ERROR", code: "8541", message: "Missing required attribute" }],
      summary: { buyable: true, discoverable: true }, hasLiveOffer: true,
    },
    {
      sku: "SKU-STRAND", asin: "B101", productName: "Stranded stock", brand: "Alpha",
      listingStatus: "Inactive", fulfillmentChannel: "FBA", price: 299, currency: "INR",
      listingQuantity: 0, fbaAvailable: 40, snapshotAvailable: 40,
      sales30d: 0, units30d: 0, hasSalesData: false,
      issues: [], summary: { buyable: false, discoverable: true }, hasLiveOffer: false,
    },
    {
      sku: "SKU-FBM", asin: "B102", productName: "FBM no price", brand: "Beta",
      listingStatus: "Active", fulfillmentChannel: "FBM", price: 0, currency: "INR",
      listingQuantity: 12, fbaAvailable: 0, snapshotAvailable: null,
      sales30d: 500, units30d: 2, hasSalesData: true,
      issues: [], summary: null, hasLiveOffer: null,
    },
    {
      sku: "SKU-OK", asin: "B103", productName: "Healthy", brand: "Beta",
      listingStatus: "Active", fulfillmentChannel: "FBA", price: 999, currency: "INR",
      listingQuantity: 0, fbaAvailable: 5, snapshotAvailable: 5,
      sales30d: 9000, units30d: 9, hasSalesData: true,
      issues: [], summary: { buyable: true, discoverable: true }, hasLiveOffer: true,
    },
  ],
};

test("listing gates are applied in the documented order", () => {
  const rows = buildListingHealthRows(listingData, "ALL");
  const byS = Object.fromEntries(rows.map((row) => [row.sku, row]));
  assert.equal(byS["SKU-ERR"].gate, "error");
  assert.equal(byS["SKU-STRAND"].gate, "suppressed");
  assert.equal(byS["SKU-FBM"].gate, "no_price");
  assert.equal(byS["SKU-OK"].gate, "ok");
});

test("units on hand never adds two views of the same stock", () => {
  const rows = buildListingHealthRows(listingData, "ALL");
  const byS = Object.fromEntries(rows.map((row) => [row.sku, row]));
  // FBA offer: snapshot value only, not snapshot + listing quantity.
  assert.equal(byS["SKU-ERR"].unitsOnHand, 10);
  // FBM offer: merchant quantity only.
  assert.equal(byS["SKU-FBM"].unitsOnHand, 12);
});

test("a healthy listing has no sales at risk", () => {
  const rows = buildListingHealthRows(listingData, "ALL");
  const ok = rows.find((row) => row.sku === "SKU-OK");
  assert.equal(ok.salesAtRisk, 0);
});

test("without the raw-issues table nothing is labelled suppressed", () => {
  const withoutIssues = {
    ...listingData,
    issuesAvailable: false,
    rows: listingData.rows.map((row) => ({ ...row, issues: [], summary: null, hasLiveOffer: null })),
  };
  const rows = buildListingHealthRows(withoutIssues, "ALL");
  assert.ok(!rows.some((row) => row.gate === "suppressed"), "must not infer suppression");
  assert.ok(!rows.some((row) => row.gate === "error"), "must not infer an error");
  // The Inactive listing is still detected from listing_status alone.
  assert.equal(rows.find((row) => row.sku === "SKU-STRAND").gate, "inactive");
});

/* ---------- Buy Box ---------- */

const buyBoxData = {
  accountId: "acct-1",
  asOf: "2026-07-29",
  window: { from: "2026-07-02", to: "2026-07-29", days: 28, sliceDays: 7 },
  observedWindow: { from: "2026-07-02", to: "2026-07-28" },
  sourceLabel: "Profit by SKU & Date",
  inventoryAvailable: true,
  inventorySnapshotDate: "2026-07-29",
  currencies: ["INR"],
  rows: [
    {
      sku: "BB-PRICE", asin: "B200", productName: "Priced out", brand: "Alpha", currency: "INR",
      buyBoxPct: 40, buyBoxBasis: "page-view weighted", buyBoxDays: 28, windowDays: 28,
      sales: 10000, units: 50, pageViews: 4000,
      price: { yourPrice: 550, salesPrice: 550, featuredOfferPrice: 499, lowestPriceNewPlusShipping: 495, currency: "INR" },
      available: 100, unitsShippedT30: 60, inventoryKnown: true,
    },
    {
      sku: "BB-STOCK", asin: "B201", productName: "Out of stock", brand: "Alpha", currency: "INR",
      buyBoxPct: 20, buyBoxBasis: "page-view weighted", buyBoxDays: 28, windowDays: 28,
      sales: 5000, units: 25, pageViews: 2000,
      price: { yourPrice: 300, salesPrice: 300, featuredOfferPrice: 320, lowestPriceNewPlusShipping: 320, currency: "INR" },
      available: 0, unitsShippedT30: 30, inventoryKnown: true,
    },
    {
      sku: "BB-UNKNOWN", asin: "B202", productName: "No evidence", brand: "Beta", currency: "INR",
      buyBoxPct: 60, buyBoxBasis: "unweighted mean of observed days", buyBoxDays: 5, windowDays: 28,
      sales: 2000, units: 10, pageViews: 0,
      price: null, available: null, unitsShippedT30: null, inventoryKnown: true,
    },
    {
      sku: "BB-FINE", asin: "B203", productName: "Winning", brand: "Beta", currency: "INR",
      buyBoxPct: 99, buyBoxBasis: "page-view weighted", buyBoxDays: 28, windowDays: 28,
      sales: 20000, units: 100, pageViews: 9000,
      price: { yourPrice: 100, salesPrice: 100, featuredOfferPrice: 100, lowestPriceNewPlusShipping: 100, currency: "INR" },
      available: 500, unitsShippedT30: 120, inventoryKnown: true,
    },
  ],
};

test("sales at risk is sales x (1 - buy box share)", () => {
  const rows = buildBuyBoxRows(buyBoxData, "ALL", 90);
  const byS = Object.fromEntries(rows.map((row) => [row.sku, row]));
  assert.equal(byS["BB-PRICE"].salesAtRisk, 10000 * 0.6);
  assert.equal(byS["BB-STOCK"].salesAtRisk, 5000 * 0.8);
});

test("buy box causes are only claimed with evidence", () => {
  const rows = buildBuyBoxRows(buyBoxData, "ALL", 90);
  const byS = Object.fromEntries(rows.map((row) => [row.sku, row]));
  assert.equal(byS["BB-PRICE"].cause, "price");
  assert.equal(byS["BB-STOCK"].cause, "stock");
  assert.equal(byS["BB-UNKNOWN"].cause, "unconfirmed");
  const insights = buildBuyBoxInsights(buyBoxData, rows, 90);
  const unknown = insights.find((insight) => insight.sku === "BB-UNKNOWN");
  assert.equal(unknown.confidence, "low");
  assert.ok(/not present/i.test(unknown.why));
});

test("the threshold is local and changes which rows are flagged", () => {
  assert.equal(buildBuyBoxRows(buyBoxData, "ALL", 90).filter((row) => row.belowThreshold).length, 3);
  assert.equal(buildBuyBoxRows(buyBoxData, "ALL", 50).filter((row) => row.belowThreshold).length, 2);
  assert.equal(buildBuyBoxRows(buyBoxData, "ALL", 100).filter((row) => row.belowThreshold).length, 4);
});

test("a SKU holding the buy box produces no insight", () => {
  const rows = buildBuyBoxRows(buyBoxData, "ALL", 90);
  const insights = buildBuyBoxInsights(buyBoxData, rows, 90);
  assert.ok(!insights.some((insight) => insight.sku === "BB-FINE"));
});

/* ---------- Returns & Refund Leakage ---------- */

const returnsData = {
  accountId: "acct-1",
  asOf: "2026-07-29",
  window: { from: "2026-05-31", to: "2026-07-29", days: 60 },
  returnsSourceLabel: "Returns (FBA & FBM)",
  moneySourceLabel: "Settlements & P&L Components",
  rateSourceLabel: "Order Line Items",
  rateSourceLagDays: 0,
  returnHistoryDays: 60,
  returnRecordCount: 46,
  pendingReturnRequests: 3,
  fbmOnly: { refundedAmount: 0, sellerBorneLabelCost: 0 },
  reasonTotals: [
    { reason: "DEFECTIVE", count: 22, bucket: "product_quality" },
    { reason: "APPAREL_TOO_SMALL", count: 14, bucket: "sizing" },
    { reason: "UNWANTED_ITEM", count: 10, bucket: "low_actionability" },
  ],
  currencies: ["INR"],
  rows: [
    {
      asin: "R100", sku: "SKU-Q", skuCount: 1, productName: "Defect-prone item", brand: "Alpha", currency: "INR",
      returnCount: 20, fbaReturns: 18, fbmReturns: 2, pendingReturnRequests: 1,
      reasonBuckets: { product_quality: 15, low_actionability: 5 },
      topReasons: [{ reason: "DEFECTIVE", count: 15 }, { reason: "UNWANTED_ITEM", count: 5 }],
      refundedAmount: 12000, refundTax: 500, returnFees: 900, refundedReferralFeeCredit: 800,
      cogsOnRefundedUnits: 4000, refundedUnitsSettled: 20, refundEvents: 20,
      settledSales: 90000, settledUnits: 150, hasMoney: true,
      orderedUnits: 150, returnedUnits: 20, sales: 96000, hasOrdered: true,
    },
    {
      asin: "R200", sku: "SKU-LAG", skuCount: 1, productName: "Lag artefact item", brand: "Alpha", currency: "INR",
      returnCount: 9, fbaReturns: 9, fbmReturns: 0, pendingReturnRequests: 0,
      reasonBuckets: { sizing: 4, low_actionability: 3, delivery: 2 },
      topReasons: [{ reason: "APPAREL_TOO_SMALL", count: 4 }],
      refundedAmount: 3000, refundTax: 0, returnFees: 200, refundedReferralFeeCredit: 0,
      cogsOnRefundedUnits: 900, refundedUnitsSettled: 9, refundEvents: 9,
      settledSales: 2000, settledUnits: 5, hasMoney: true,
      orderedUnits: 5, returnedUnits: 9, sales: 2400, hasOrdered: true,
    },
  ],
};

test("return leakage is refunds plus seller-borne fees and excludes COGS", () => {
  const rows = buildReturnsRows(returnsData, "ALL");
  const byAsin = Object.fromEntries(rows.map((row) => [row.asin, row]));
  assert.equal(byAsin.R100.totalLeakage, 12000 + 900);
  // COGS on refunded units must be reported but never folded into the money.
  assert.equal(byAsin.R100.cogsOnRefundedUnits, 4000);
  assert.ok(byAsin.R100.totalLeakage < 12000 + 900 + 4000);
});

test("a return rate above 100% is withheld as a lag artefact", () => {
  const rows = buildReturnsRows(returnsData, "ALL");
  const byAsin = Object.fromEntries(rows.map((row) => [row.asin, row]));
  assert.equal(byAsin.R100.returnRate, (20 / 150) * 100);
  assert.equal(byAsin.R200.lagInflated, true);
  assert.equal(byAsin.R200.returnRate, null, "must not report a rate above 100%");
});

test("Blocker 3: the portfolio return rate is a PROVEN PARTIAL over rows with known returned units, never an understated complete rate", () => {
  // A currency-ambiguous ASIN (M) spans USD + CAD, so its returnedUnits are WITHHELD (null) on BOTH rows.
  // A single-currency ASIN (S) has a known count. The proven rate must divide S's returned units by S's
  // ordered units ONLY -- M's ordered units (which have no proven numerator) must NOT sit in the denominator.
  const data = {
    ...returnsData,
    currencies: ["CAD", "USD"],
    rows: [
      { asin: "M", sku: "SKU-M", skuCount: 1, productName: "Multi", brand: "Alpha", currency: "USD", returnCount: 0, fbaReturns: 0, fbmReturns: 0, pendingReturnRequests: 0, reasonBuckets: {}, topReasons: [], refundedAmount: 0, returnFees: 0, cogsOnRefundedUnits: 0, refundedUnitsSettled: 0, refundEvents: 0, settledSales: 0, settledUnits: 0, hasMoney: false, orderedUnits: 30, returnedUnits: null, sales: 300, hasOrdered: true },
      { asin: "M", sku: "SKU-M", skuCount: 1, productName: "Multi", brand: "Alpha", currency: "CAD", returnCount: 0, fbaReturns: 0, fbmReturns: 0, pendingReturnRequests: 0, reasonBuckets: {}, topReasons: [], refundedAmount: 0, returnFees: 0, cogsOnRefundedUnits: 0, refundedUnitsSettled: 0, refundEvents: 0, settledSales: 0, settledUnits: 0, hasMoney: false, orderedUnits: 20, returnedUnits: null, sales: 200, hasOrdered: true },
      { asin: "S", sku: "SKU-S", skuCount: 1, productName: "Single", brand: "Alpha", currency: "USD", returnCount: 2, fbaReturns: 2, fbmReturns: 0, pendingReturnRequests: 0, reasonBuckets: { product_quality: 2 }, topReasons: [{ reason: "DEFECTIVE", count: 2 }], refundedAmount: 40, returnFees: 5, cogsOnRefundedUnits: 0, refundedUnitsSettled: 2, refundEvents: 2, settledSales: 0, settledUnits: 0, hasMoney: true, orderedUnits: 20, returnedUnits: 2, sales: 200, hasOrdered: true },
    ],
  };
  const rows = buildReturnsRows(data, "ALL");
  const { rate, ratePartial } = returnsPortfolioRate(rows);
  assert.equal(rate, (2 / 20) * 100, "proven rate = S returned / S ordered = 10% (M's ordered units excluded)");
  assert.equal(ratePartial, true, "the KPI is a proven PARTIAL because a withheld ASIN carries ordered units");
  // The understated 'complete' rate would spread S's 2 returns over ALL 70 ordered units (2/70 ≈ 2.86%).
  assert.notEqual(rate, (2 / 70) * 100, "never the understated complete rate that includes withheld rows' ordered units");
});

test("a return cause is only named when one bucket is at least half the returns", () => {
  const rows = buildReturnsRows(returnsData, "ALL");
  const insights = buildReturnsInsights(returnsData, rows);
  const clear = insights.find((item) => item.asin === "R100");
  assert.equal(clear.category, "returns-product_quality");
  assert.equal(clear.confidence, "high");
  // R200's largest bucket is 4 of 9 returns, i.e. under half.
  const mixed = insights.find((item) => item.asin === "R200");
  assert.equal(mixed.category, "returns-mixed");
  assert.equal(mixed.confidence, "medium");
  assert.ok(/does not attribute one cause/i.test(mixed.why));
});

test("return reason strings map to the documented buckets", () => {
  assert.equal(classifyReturnReason("DEFECTIVE"), "product_quality");
  assert.equal(classifyReturnReason("MISSING_PARTS"), "product_quality");
  assert.equal(classifyReturnReason("NOT_AS_DESCRIBED"), "listing_accuracy");
  assert.equal(classifyReturnReason("APPAREL_TOO_LARGE"), "sizing");
  assert.equal(classifyReturnReason("UNDELIVERABLE_REFUSED"), "delivery");
  assert.equal(classifyReturnReason("NO_REASON_GIVEN"), "low_actionability");
  assert.equal(classifyReturnReason("SOMETHING_BRAND_NEW"), "other");
  assert.equal(classifyReturnReason(""), "other");
});

test("a systemic fixable reason produces an account-level insight", () => {
  const insights = buildReturnsInsights(returnsData, buildReturnsRows(returnsData, "ALL"));
  const account = insights.find((item) => item.category === "returns-account-pattern");
  assert.ok(account, "expected an account-level pattern insight");
  assert.equal(account.moneyAtRisk, null, "an account pattern has no single monetary basis");
  assert.ok(/product \/ quality/i.test(account.title));
});

/* ---------- PPC Performance & Wasted Spend ---------- */

const ppcData = {
  accountId: "acct-1",
  asOf: "2026-07-29",
  window: { from: "2026-06-30", to: "2026-07-29", days: 30 },
  minClicksForWaste: 10,
  adsRowCount: 400,
  latestMetricDate: "2026-07-28",
  totalSales: 200000,
  totalSalesSourceLabel: "Order Line Items",
  totalSalesLagDays: 0,
  currencies: ["INR"],
  sourceAvailability: [
    { key: "campaign-performance-v1", label: "Ad Performance by Campaign & Date", coverage: "All campaign types", rows: 200, sync: null, defaultDataset: true },
    { key: "search-terms-performance-v1", label: "Search Term Performance (Ads)", coverage: "SP + SB only (no Sponsored Display)", rows: 200, sync: null, defaultDataset: false },
  ],
  searchTerms: [
    {
      key: "dead", searchTerm: "cheap knockoff thing", campaignName: "C1", campaignType: "SPONSORED_PRODUCTS",
      spend: 4000, sales: 0, clicks: 120, impressions: 9000, orders: 0, units: 0,
      currencies: ["INR"], campaignTypes: ["SPONSORED_PRODUCTS"], activeDays: 28,
    },
    {
      key: "smallsample", searchTerm: "brand new term", campaignName: "C1", campaignType: "SPONSORED_PRODUCTS",
      spend: 60, sales: 0, clicks: 4, impressions: 200, orders: 0, units: 0,
      currencies: ["INR"], campaignTypes: ["SPONSORED_PRODUCTS"], activeDays: 3,
    },
    {
      key: "breach", searchTerm: "expensive but converting", campaignName: "C2", campaignType: "SPONSORED_BRANDS",
      spend: 1000, sales: 2000, clicks: 90, impressions: 5000, orders: 10, units: 11,
      currencies: ["INR"], campaignTypes: ["SPONSORED_BRANDS"], activeDays: 30,
    },
    {
      key: "scale", searchTerm: "great term", campaignName: "C2", campaignType: "SPONSORED_PRODUCTS",
      spend: 500, sales: 5000, clicks: 80, impressions: 4000, orders: 25, units: 26,
      currencies: ["INR"], campaignTypes: ["SPONSORED_PRODUCTS"], activeDays: 30,
    },
  ],
};

test("PPC ratios are recomputed from summed numerators and denominators", () => {
  const metrics = ppcMetrics({ spend: 1000, sales: 4000, clicks: 200, impressions: 10000, orders: 20, units: 22 }, { totalSales: 50000 });
  assert.equal(metrics.acos, 25);
  assert.equal(metrics.roas, 4);
  assert.equal(metrics.cpc, 5);
  assert.equal(metrics.ctr, 2);
  assert.equal(metrics.cvr, 10);
  assert.equal(metrics.tacos, 2);
});

test("TACoS is withheld when total account sales is unavailable", () => {
  const metrics = ppcMetrics({ spend: 100, sales: 100, clicks: 1, impressions: 1, orders: 1, units: 1 }, { totalSales: null });
  assert.equal(metrics.tacos, null);
});

test("PPC rollups keep the same campaign separate by currency", () => {
  const rows = [
    { currency: "INR", campaign_id: "C1", campaign_type: "SPONSORED_PRODUCTS", metric_date: "2026-07-01", metrics: { ad_spend: 100, ad_sales: 400, ad_clicks: 20, ad_impressions: 1000, ad_orders: 4, ad_units_sold: 4 } },
    { currency: "USD", campaign_id: "C1", campaign_type: "SPONSORED_PRODUCTS", metric_date: "2026-07-01", metrics: { ad_spend: 7, ad_sales: 28, ad_clicks: 2, ad_impressions: 100, ad_orders: 1, ad_units_sold: 1 } },
  ];
  const rolled = rollupPpcRows(
    rows,
    (row) => `${row.campaign_id}|${row.campaign_type}`,
    (row) => ({ campaignId: row.campaign_id, campaignType: row.campaign_type }),
    { salesKey: "ad_sales", ordersKey: "ad_orders", unitsKey: "ad_units_sold" }
  );
  assert.equal(rolled.length, 2, "one campaign in two currencies must remain two rows");
  const inr = rolled.find((row) => row.currencies[0] === "INR");
  const usd = rolled.find((row) => row.currencies[0] === "USD");
  assert.equal(inr.spend, 100);
  assert.equal(usd.spend, 7);
  assert.notEqual(inr.key, usd.key);
});

test("stale shared snapshots must match the current report version", () => {
  assert.equal(staleSnapshotMatchesReportVersion({ params: { reportVersion: "ppc-v2" } }, "ppc-v2"), true);
  assert.equal(staleSnapshotMatchesReportVersion({ params: { reportVersion: "ppc-v1" } }, "ppc-v2"), false);
  assert.equal(staleSnapshotMatchesReportVersion({ params: {} }, "ppc-v2"), false);
});

test("marketplace profiles cover Europe and use the marketplace business day", () => {
  assert.deepEqual(
    marketplaceProfile("DE"),
    { country: "DE", countryName: "Germany", currency: "EUR", locale: "de-DE", timeZone: "Europe/Berlin" }
  );
  assert.equal(marketplaceProfile("CA").currency, "CAD");
  assert.equal(marketplaceProfile("PL").currency, "PLN");
  assert.equal(marketplaceToday("US", new Date("2026-07-30T01:30:00.000Z")), "2026-07-29");
  assert.equal(marketplaceToday("IN", new Date("2026-07-30T01:30:00.000Z")), "2026-07-30");
});

test("dead spend needs the minimum click count", () => {
  const rows = buildPpcRows(ppcData, "searchTerms", { breakEvenAcos: 30, selectedBrand: "ALL" });
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  assert.equal(byKey.dead.waste.kind, "dead");
  assert.equal(byKey.dead.waste.wasted, 4000, "all spend is waste when nothing converted");
  // 4 clicks is a small sample, not proven waste.
  assert.equal(byKey.smallsample.waste.kind, "watch");
  assert.equal(byKey.smallsample.waste.wasted, 0);
});

test("a break-even breach only counts the spend above break-even", () => {
  const rows = buildPpcRows(ppcData, "searchTerms", { breakEvenAcos: 30, selectedBrand: "ALL" });
  const breach = rows.find((row) => row.key === "breach");
  assert.equal(breach.waste.kind, "breach");
  // ACoS is 50%; break-even spend on 2000 sales at 30% is 600, so 400 is waste.
  assert.equal(breach.waste.wasted, 400);
  assert.ok(breach.waste.wasted < breach.spend, "must not treat all spend as waste");
});

test("profitable rows are surfaced as scaling opportunities, not waste", () => {
  const rows = buildPpcRows(ppcData, "searchTerms", { breakEvenAcos: 30, selectedBrand: "ALL" });
  const scale = rows.find((row) => row.key === "scale");
  assert.equal(scale.waste.kind, "scale");
  assert.equal(scale.waste.wasted, 0);
  const insights = buildPpcInsights(ppcData, rows, "searchTerms", 30);
  const opportunity = insights.find((item) => item.category === "ppc-scaling");
  assert.ok(opportunity);
  assert.equal(opportunity.kind, "opportunity");
  // Risks must still rank ahead of opportunities.
  assert.equal(insights[0].kind, "risk");
});

test("the break-even input changes waste without any refetch", () => {
  const at30 = buildPpcRows(ppcData, "searchTerms", { breakEvenAcos: 30, selectedBrand: "ALL" });
  const at60 = buildPpcRows(ppcData, "searchTerms", { breakEvenAcos: 60, selectedBrand: "ALL" });
  const breach30 = at30.find((row) => row.key === "breach").waste;
  const breach60 = at60.find((row) => row.key === "breach").waste;
  assert.equal(breach30.kind, "breach");
  assert.notEqual(breach60.kind, "breach", "a 50% ACoS is inside a 60% break-even");
});

test("search-term insights never claim Sponsored Display coverage", () => {
  const rows = buildPpcRows(ppcData, "searchTerms", { breakEvenAcos: 30, selectedBrand: "ALL" });
  const insights = buildPpcInsights(ppcData, rows, "searchTerms", 30);
  for (const item of insights) {
    assert.ok(/SP \+ SB only/.test(item.freshness), "freshness must state the SP+SB-only coverage");
    assert.ok(!/SPONSORED_DISPLAY/i.test(item.freshness));
  }
});

test("PPC actions stay read-only", () => {
  const rows = buildPpcRows(ppcData, "searchTerms", { breakEvenAcos: 30, selectedBrand: "ALL" });
  for (const item of buildPpcInsights(ppcData, rows, "searchTerms", 30)) {
    assert.ok(/read-only|Read-only/.test(item.action), `action must state it changes nothing: ${item.action}`);
  }
});

/* ---------- Listing & Search Optimizer ---------- */

function sqpQuery(overrides) {
  return {
    asin: "O100", query: "cotton bath towel", volume: 10000,
    totalImpressions: 100000, totalClicks: 5000, totalCartAdds: 900, totalPurchases: 500,
    asinImpressions: 20000, asinClicks: 1000, asinCartAdds: 180, asinPurchases: 100,
    bestRank: 8, periodCount: 8,
    ...overrides,
  };
}

const optimizerData = {
  accountId: "acct-1",
  asOf: "2026-07-29",
  window: { from: "2026-05-06", to: "2026-07-29", days: 84 },
  sqpAvailable: true,
  sqpSourceLabel: "Search Query Performance (SQP) by ASIN (Weekly)",
  contentSourceLabel: "Product Catalog by ASIN",
  periods: ["2026-06-01", "2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29", "2026-07-06", "2026-07-13", "2026-07-20"],
  periodCount: 8,
  queries: [
    // Healthy on every dimension.
    sqpQuery({ query: "cotton bath towel" }),
    // Low share, at-market CVR, weak rank -> discoverability.
    sqpQuery({ query: "quick dry towel set", asinImpressions: 2000, asinClicks: 100, asinPurchases: 10, bestRank: 60 }),
    // Impressions but far fewer clicks than the market -> click-rate.
    sqpQuery({ query: "luxury towel", asinImpressions: 40000, asinClicks: 400, asinPurchases: 40 }),
    // Clicks at market but almost no purchases -> conversion.
    sqpQuery({ query: "towel gift box", asinClicks: 1000, asinPurchases: 5 }),
    // Missing market denominators -> must stay unclassified.
    sqpQuery({ query: "mystery term", totalImpressions: 0, totalClicks: 0, totalPurchases: 0, asinPurchases: 1 }),
    // The biggest converter for this ASIN. Its words "hotel", "spa" and "towel"
    // are in the title but "bundle" is not, so the title-gap check must fire.
    sqpQuery({ query: "hotel spa towel bundle", asinPurchases: 300 }),
  ],
  products: [
    {
      asin: "O100",
      name: "BrandX Premium Cotton Bath Towel Set of 4 - Best Value!! Absorbent Quick Dry Towel for Bathroom Spa Hotel Use",
      brand: "Alpha",
      category: "Home",
      bestSellerRank: 1200,
      bullets: ["Soft cotton", "Absorbent"],
      description: null,
      hasImage: true,
    },
  ],
  catalogBrands: ["Alpha"],
};

test("optimizer funnel rates come from summed counts and compare to the market", () => {
  const metrics = optimizerQueryMetrics(sqpQuery({}));
  assert.equal(metrics.impressionShare, 20000 / 100000);
  assert.equal(metrics.yourCtr, 1000 / 20000);
  assert.equal(metrics.marketCtr, 5000 / 100000);
  assert.equal(metrics.yourCvr, 100 / 1000);
  assert.equal(metrics.marketCvr, 500 / 5000);
  assert.equal(metrics.ctrVsMarket, 1);
  assert.equal(metrics.cvrVsMarket, 1);
});

test("optimizer gates follow the documented order", () => {
  const gateOf = (overrides) => classifyOptimizerQuery(optimizerQueryMetrics(sqpQuery(overrides)));
  assert.equal(gateOf({}), "strong");
  assert.equal(gateOf({ asinImpressions: 2000, asinClicks: 100, asinPurchases: 10, bestRank: 60 }), "discoverability");
  assert.equal(gateOf({ asinImpressions: 40000, asinClicks: 400, asinPurchases: 40 }), "click_rate");
  assert.equal(gateOf({ asinClicks: 1000, asinPurchases: 5 }), "conversion");
  // Low share with both CTR and CVR under market is someone else's query.
  assert.equal(gateOf({ asinImpressions: 2000, asinClicks: 20, asinPurchases: 0 }), "relevance");
});

test("a query with no market denominators is never given a cause", () => {
  const metrics = optimizerQueryMetrics(sqpQuery({ totalImpressions: 0, totalClicks: 0, totalPurchases: 0 }));
  assert.equal(classifyOptimizerQuery(metrics), null);
  const rows = buildOptimizerRows(optimizerData, "ALL");
  const unclassified = rows[0].queries.filter((query) => !query.gate);
  assert.equal(unclassified.length, 1);
  assert.equal(unclassified[0].query, "mystery term");
});

test("title audit applies Amazon's published 2026 rules", () => {
  const audit = auditTitle(optimizerData.products[0].name);
  assert.equal(audit.overLength, true, "title is longer than the 75-character limit");
  assert.ok(audit.length > TITLE_MAX_CHARS);
  assert.equal(audit.promotionalWord.toLowerCase(), "best");
  assert.equal(audit.bannedSymbol, "!");
  const clean = auditTitle("BrandX Cotton Bath Towel Set of 4 for Bathroom");
  assert.equal(clean.overLength, false);
  assert.equal(clean.promotionalWord, null);
  assert.equal(clean.bannedSymbol, null);
});

test("content gaps and keyword gaps are measured, not invented", () => {
  const [row] = buildOptimizerRows(optimizerData, "ALL");
  assert.ok(row.contentIssues.some((issue) => /over Amazon's 75-character limit/.test(issue)));
  assert.ok(row.contentIssues.some((issue) => /Only 2 of 5 bullet points/.test(issue)));
  assert.ok(row.contentIssues.some((issue) => /No product description/.test(issue)));
  // "gift" and "box" convert but appear nowhere in the title, bullets or
  // description; "cotton" does appear, so it must NOT be reported as a gap.
  const gapTokens = row.keywordGaps.map((gap) => gap.token);
  assert.ok(!gapTokens.includes("cotton"), "a word already in the listing is not a gap");
  assert.ok(gapTokens.includes("gift") || gapTokens.includes("box"));
});

test("optimizer insights carry no fabricated money value", () => {
  const rows = buildOptimizerRows(optimizerData, "ALL");
  const insights = buildOptimizerInsights(optimizerData, rows);
  assert.ok(insights.length > 0);
  for (const item of insights) {
    // SQP reports purchase counts, not revenue. Inventing a price to multiply
    // by would be fabrication, so money must stay null.
    assert.equal(item.moneyAtRisk, null);
    assert.ok(item.action.length > 10);
    assert.ok(item.evidence.length > 0);
  }
});

test("optimizer never offers to modify a listing itself", () => {
  const insights = buildOptimizerInsights(optimizerData, buildOptimizerRows(optimizerData, "ALL"));
  const titleInsight = insights.find((item) => item.category === "optimizer-title-gap");
  assert.ok(titleInsight, "the top converting term is missing from this title");
  assert.ok(/does not rewrite listings/i.test(titleInsight.action));
});

test("a disabled SQP table yields no rows rather than an error", () => {
  const disabled = { ...optimizerData, sqpAvailable: false, queries: [], products: [] };
  assert.deepEqual(buildOptimizerRows(disabled, "ALL"), []);
  assert.deepEqual(buildOptimizerInsights(disabled, []), []);
});

/* ---------- ranking, dedupe, export ---------- */

function insight(overrides) {
  return makeInsight({
    id: overrides.id,
    reportKey: overrides.reportKey || "r",
    reportLabel: "R",
    severity: overrides.severity,
    category: overrides.category || "c",
    title: overrides.id,
    asin: overrides.asin || null,
    moneyAtRisk: overrides.moneyAtRisk ?? null,
    currency: overrides.currency || "INR",
    kind: overrides.kind || "risk",
    why: "because the numbers say so",
    action: "do the thing",
    evidence: [{ label: "Metric", value: 1 }],
  });
}

test("ranking puts risks first, then severity, then money", () => {
  const ordered = sortInsights([
    insight({ id: "low-big", severity: "low", moneyAtRisk: 9999 }),
    insight({ id: "high-small", severity: "high", moneyAtRisk: 5 }),
    insight({ id: "high-big", severity: "high", moneyAtRisk: 500 }),
    insight({ id: "opportunity", severity: "high", moneyAtRisk: 100000, kind: "opportunity" }),
  ]).map((item) => item.id);
  assert.deepEqual(ordered, ["high-big", "high-small", "low-big", "opportunity"]);
});

test("money is not compared across currencies", () => {
  const ordered = sortInsights([
    insight({ id: "inr", severity: "high", moneyAtRisk: 100, currency: "INR" }),
    insight({ id: "usd", severity: "high", moneyAtRisk: 5, currency: "USD" }),
  ]).map((item) => item.id);
  // With mixed currencies the 100 INR must not outrank 5 USD on money alone;
  // the tie falls through to confidence then label order.
  assert.deepEqual(ordered, ["inr", "usd"]);
});

test("dedupe collapses repeats for the same report, category and entity", () => {
  const deduped = dedupeInsights([
    insight({ id: "a1", severity: "medium", asin: "B1", moneyAtRisk: 10 }),
    insight({ id: "a2", severity: "high", asin: "B1", moneyAtRisk: 20 }),
    insight({ id: "b1", severity: "low", asin: "B2", moneyAtRisk: 1 }),
  ]);
  assert.equal(deduped.length, 2);
  const merged = deduped.find((item) => item.asin === "B1");
  assert.equal(merged.severity, "high", "the most severe survives");
  assert.equal(merged.mergedCount, 2);
});

test("dedupe keeps genuinely different problems on the same ASIN", () => {
  // The feed must collapse a repeated alert, but a Buy Box loss and a returns
  // problem on the same ASIN are two different problems with two different
  // fixes. Merging them would hide real work.
  const deduped = dedupeInsights([
    insight({ id: "bb", reportKey: "buy-box-loss", category: "buybox-price", asin: "B1", severity: "high", moneyAtRisk: 100 }),
    insight({ id: "ret", reportKey: "returns-leakage", category: "returns-sizing", asin: "B1", severity: "medium", moneyAtRisk: 50 }),
    insight({ id: "bb-dup", reportKey: "buy-box-loss", category: "buybox-price", asin: "B1", severity: "low", moneyAtRisk: 10 }),
  ]);
  assert.equal(deduped.length, 2, "the repeated Buy Box alert merges, the returns alert stays");
  const buyBox = deduped.find((item) => item.reportKey === "buy-box-loss");
  assert.equal(buyBox.mergedCount, 2);
  assert.equal(buyBox.severity, "high");
  assert.ok(deduped.some((item) => item.reportKey === "returns-leakage"));
});

test("feed grouping never puts two currencies in one money total", () => {
  // This mirrors what PriorityFeed does: bucket by currency, and send anything
  // without a monetary basis to its own group.
  const items = [
    insight({ id: "inr1", severity: "high", moneyAtRisk: 100, currency: "INR" }),
    insight({ id: "inr2", severity: "medium", moneyAtRisk: 40, currency: "INR" }),
    insight({ id: "usd1", severity: "high", moneyAtRisk: 7, currency: "USD" }),
    insight({ id: "none", severity: "medium", moneyAtRisk: null, currency: null }),
  ];
  const groups = new Map();
  for (const item of items) {
    const key = item.moneyAtRisk === null || !item.currency ? "__none__" : item.currency;
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  assert.equal(groups.size, 3);
  assert.equal(groups.get("INR").reduce((sum, item) => sum + item.moneyAtRisk, 0), 140);
  assert.equal(groups.get("USD").reduce((sum, item) => sum + item.moneyAtRisk, 0), 7);
  assert.equal(groups.get("__none__").length, 1);
  assert.equal(groups.get("__none__")[0].moneyAtRisk, null);
});

test("insight export carries evidence, money basis, confidence and freshness", () => {
  const [row] = insightExportRows([insight({ id: "x", severity: "high", moneyAtRisk: 12.5 })]);
  for (const column of ["Report", "Priority", "Product", "Insight", "Money at Risk", "Currency", "Evidence", "Why Flagged", "Recommended Action", "Confidence"]) {
    assert.ok(column in row, `missing column ${column}`);
  }
  assert.equal(row["Money at Risk"], "12.50");
});

/* ---------- CSV and formatting guards ---------- */

test("CSV escapes spreadsheet formulas and quotes", () => {
  assert.equal(csvCell("=1+1"), "\"'=1+1\"");
  assert.equal(csvCell("+SUM(A1)"), "\"'+SUM(A1)\"");
  assert.equal(csvCell("-2"), "\"'-2\"");
  assert.equal(csvCell("@cmd"), "\"'@cmd\"");
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell(null), '""');
});

test("CSV output starts with a UTF-8 BOM so Excel reads it correctly", () => {
  const text = csvText([{ A: "1", B: "₹2" }]);
  assert.equal(text.charCodeAt(0), 0xfeff);
  assert.ok(text.includes("₹2"));
});

test("unknown numbers render as an em dash, never as zero", () => {
  assert.equal(nInt(null), "—");
  assert.equal(nInt(undefined), "—");
  assert.equal(fmtMoney(null, "INR"), "—");
  assert.equal(ratio(1, 0), null);
  assert.equal(nInt(0), "0");
  assert.equal(fmtMoney(0, "INR"), "₹0");
});

console.log(`\n${passed} assertions passed${process.exitCode ? " (with failures above)" : ""}`);
