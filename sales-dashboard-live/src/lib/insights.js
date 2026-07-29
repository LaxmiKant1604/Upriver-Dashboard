// The Insight Engine.
//
// This is deliberately NOT generative text. Every insight is a deterministic
// function of numbers that came from a named DataDoe column, and every insight
// carries the evidence that produced it so a reader can check it. The rules are:
//
//  * An insight must state its severity, the metric evidence behind it, the
//    money at risk where a monetary basis genuinely exists, the freshness and
//    confidence of the data, why it was flagged, and one recommended action.
//  * A cause is only named when the underlying columns support it. When the
//    evidence is missing the insight says the cause is unconfirmed instead of
//    guessing, and `confidence` drops.
//  * Money at risk is always in one currency, tagged with `currency`, and is
//    never added across currencies.
//  * Ratios are recomputed from summed numerators and denominators here. No
//    percentage is ever averaged or summed.
//
// It runs in the browser on data the server already fetched, which is what lets
// the shared header brand filter, search, sorting and paging re-derive every
// insight locally without a single DataDoe request.

import { ratio } from "./format.js";

export const SEVERITIES = ["high", "medium", "low"];
export const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
export const SEVERITY_LABEL = { high: "High priority", medium: "Medium priority", low: "Low priority" };
export const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 };

/**
 * Build one insight. `evidence` is an ordered list of {label, value} pairs that
 * are shown verbatim, so the reader sees the same numbers the rule used.
 */
export function makeInsight({
  id,
  reportKey,
  reportLabel,
  kind = "risk",              // "risk" | "opportunity"
  severity = "low",
  category,
  title,
  asin = null,
  sku = null,
  entityLabel = null,
  brand = null,
  evidence = [],
  moneyAtRisk = null,
  moneyBasis = null,
  currency = null,
  confidence = "medium",
  freshness = null,
  why,
  action,
}) {
  return {
    id,
    reportKey,
    reportLabel,
    kind,
    severity: SEVERITIES.includes(severity) ? severity : "low",
    category: category || reportKey,
    title,
    asin,
    sku,
    entityLabel: entityLabel || asin || sku || "Account",
    brand,
    evidence: evidence.filter((item) => item && item.value !== null && item.value !== undefined && item.value !== ""),
    moneyAtRisk: Number.isFinite(moneyAtRisk) ? moneyAtRisk : null,
    moneyBasis: moneyBasis || null,
    currency: currency || null,
    confidence,
    freshness: freshness || null,
    why,
    action,
  };
}

/**
 * Priority order: risks before opportunities, then severity, then money at risk
 * (descending), then confidence, then a stable label tie-break.
 *
 * Money is only compared between insights that share a currency. Mixed-currency
 * accounts therefore rank within a severity band by severity and confidence
 * rather than by a meaningless cross-currency number.
 */
export function sortInsights(insights) {
  const currencies = new Set(insights.map((insight) => insight.currency).filter(Boolean));
  const moneyComparable = currencies.size <= 1;
  return [...insights].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "risk" ? -1 : 1;
    const severity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severity !== 0) return severity;
    if (moneyComparable) {
      const money = (b.moneyAtRisk ?? -1) - (a.moneyAtRisk ?? -1);
      if (money !== 0) return money;
    }
    const confidence = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    if (confidence !== 0) return confidence;
    return String(a.entityLabel).localeCompare(String(b.entityLabel));
  });
}

/**
 * Collapse repeated alerts for the same account/ASIN/category. The most severe
 * (then highest-money) insight survives and records how many were merged, so
 * the cross-report feed never shows the same problem five times.
 */
export function dedupeInsights(insights) {
  const byKey = new Map();
  for (const insight of sortInsights(insights)) {
    const key = [insight.reportKey, insight.category, insight.asin || "", insight.sku || ""].join("|");
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...insight, mergedCount: 1 });
      continue;
    }
    existing.mergedCount += 1;
  }
  return sortInsights([...byKey.values()]);
}

/** Flat rows for the CSV export of a report's insights and actions. */
export function insightExportRows(insights) {
  return insights.map((insight) => ({
    Report: insight.reportLabel,
    Priority: SEVERITY_LABEL[insight.severity],
    Type: insight.kind === "risk" ? "Risk" : "Opportunity",
    Category: insight.category,
    Product: insight.entityLabel,
    ASIN: insight.asin || "",
    SKU: insight.sku || "",
    Brand: insight.brand || "",
    Insight: insight.title,
    "Money at Risk": insight.moneyAtRisk === null ? "" : insight.moneyAtRisk.toFixed(2),
    Currency: insight.currency || "",
    "Money Basis": insight.moneyBasis || "",
    Evidence: insight.evidence.map((item) => `${item.label}: ${item.value}`).join("; "),
    "Why Flagged": insight.why,
    "Recommended Action": insight.action,
    Confidence: insight.confidence,
    "Data Freshness": insight.freshness || "",
  }));
}

/**
 * Severity from money at risk relative to the scope's total, plus an absolute
 * floor so a tiny account cannot produce a "high priority" over pennies.
 * `share` is the fraction of scope revenue the exposure represents.
 */
export function severityFromExposure({ share, moneyAtRisk, minMoney = 0 }) {
  if (moneyAtRisk !== null && moneyAtRisk < minMoney) return "low";
  if (share >= 0.1) return "high";
  if (share >= 0.03) return "medium";
  return "low";
}

/**
 * A shared freshness sentence. Every report shows the real as-of date and, when
 * the source has a documented reporting lag, says so rather than implying the
 * numbers are live.
 */
export function freshnessNote({ sourceLabel, asOf, lagDays, extra }) {
  const bits = [];
  if (sourceLabel) bits.push(sourceLabel);
  if (asOf) bits.push(`through ${asOf}`);
  if (lagDays) bits.push(`can lag up to about ${lagDays} day${lagDays === 1 ? "" : "s"}`);
  if (extra) bits.push(extra);
  return bits.join(" · ");
}

/* ==================================================================== */
/* Sales Movers                                                          */
/* ==================================================================== */

const SALES_MOVERS_LABEL = "Sales Movers";

/**
 * Exact week-over-week decomposition of a sales change.
 *
 * sales = sessions x (units / sessions) x (sales / units), so
 *   dSales = dSessions.cvrP.aspP + sessionsR.dCvr.aspP + sessionsR.cvrR.dAsp
 * which sums to dSales exactly. Returned only when every denominator in both
 * windows is non-zero; otherwise the caller falls back to reporting the plain
 * metric changes without attributing a share of the move to each driver.
 */
export function decomposeSalesChange(recent, prior) {
  const sessionsR = Number(recent.sessions) || 0;
  const sessionsP = Number(prior.sessions) || 0;
  const unitsR = Number(recent.units) || 0;
  const unitsP = Number(prior.units) || 0;
  if (sessionsR <= 0 || sessionsP <= 0 || unitsR <= 0 || unitsP <= 0) return null;
  const cvrR = unitsR / sessionsR;
  const cvrP = unitsP / sessionsP;
  const aspR = (Number(recent.sales) || 0) / unitsR;
  const aspP = (Number(prior.sales) || 0) / unitsP;
  return {
    traffic: (sessionsR - sessionsP) * cvrP * aspP,
    conversion: sessionsR * (cvrR - cvrP) * aspP,
    price: sessionsR * cvrR * (aspR - aspP),
  };
}

export function buildSalesMoversRows(data, selectedBrand) {
  if (!data || !Array.isArray(data.rows)) return [];
  return data.rows
    .filter((row) => selectedBrand === "ALL" || row.brand === selectedBrand)
    .map((row) => {
      const recent = row.recent || {};
      const prior = row.prior || {};
      const salesDelta = (Number(recent.sales) || 0) - (Number(prior.sales) || 0);
      const unitsDelta = (Number(recent.units) || 0) - (Number(prior.units) || 0);
      const sessionsDelta = (Number(recent.sessions) || 0) - (Number(prior.sessions) || 0);
      const cvrRecent = ratio(recent.units, recent.sessions);
      const cvrPrior = ratio(prior.units, prior.sessions);
      const aspRecent = ratio(recent.sales, recent.units);
      const aspPrior = ratio(prior.sales, prior.units);
      const contributions = decomposeSalesChange(recent, prior);

      // The dominant driver is the largest absolute contribution, and only when
      // the decomposition was computable. Otherwise it stays null and the row
      // reports the raw metric moves instead of asserting a cause.
      let dominantDriver = null;
      if (contributions) {
        const entries = Object.entries(contributions);
        entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
        if (Math.abs(entries[0][1]) > 0) dominantDriver = entries[0][0];
      }

      const adSpendDelta = (Number(row.ads?.recentSpend) || 0) - (Number(row.ads?.priorSpend) || 0);
      const adSalesDelta = (Number(row.ads?.recentSales) || 0) - (Number(row.ads?.priorSales) || 0);
      const stockedOut = row.inventory ? Number(row.inventory.available) === 0 : null;

      return {
        ...row,
        salesDelta,
        salesDeltaPct: prior.sales > 0 ? (salesDelta / prior.sales) * 100 : null,
        unitsDelta,
        sessionsDelta,
        sessionsDeltaPct: prior.sessions > 0 ? (sessionsDelta / prior.sessions) * 100 : null,
        cvrRecent, cvrPrior,
        cvrDeltaPoints: cvrRecent !== null && cvrPrior !== null ? (cvrRecent - cvrPrior) * 100 : null,
        aspRecent, aspPrior,
        aspDeltaPct: aspRecent !== null && aspPrior !== null && aspPrior !== 0
          ? ((aspRecent - aspPrior) / aspPrior) * 100
          : null,
        contributions,
        dominantDriver,
        adSpendDelta,
        adSalesDelta,
        stockedOut,
        direction: salesDelta > 0 ? "gain" : salesDelta < 0 ? "decline" : "flat",
      };
    });
}

const DRIVER_COPY = {
  traffic: {
    label: "Traffic",
    why: (row) => `sessions moved ${row.sessionsDeltaPct === null ? "with no prior baseline" : `${row.sessionsDeltaPct.toFixed(1)}%`} while conversion and price moved less`,
    action: "Check organic rank, ad impression share, and whether the listing was suppressed or out of stock in this window.",
  },
  conversion: {
    label: "Conversion",
    why: (row) => `sessions held up but units per session moved ${row.cvrDeltaPoints === null ? "unmeasurably" : `${row.cvrDeltaPoints.toFixed(2)}pp`}`,
    action: "Review the offer page: price, main image, reviews, availability badge, and recent content changes.",
  },
  price: {
    label: "Price / mix",
    why: (row) => `average selling price moved ${row.aspDeltaPct === null ? "unmeasurably" : `${row.aspDeltaPct.toFixed(1)}%`} on similar traffic and conversion`,
    action: "Confirm whether a price change, coupon, or promotion was intended, and check the margin impact in SKU P&L.",
  },
};

export function buildSalesMoversInsights(data, rows, currency) {
  if (!data || data.dataUnavailable) return [];
  const freshness = freshnessNote({
    sourceLabel: data.sourceLabel,
    asOf: data.salesLatestDate,
    lagDays: data.lagDays,
  });
  const priorTotal = rows.reduce((sum, row) => sum + (Number(row.prior?.sales) || 0), 0);
  const insights = [];

  for (const row of rows) {
    const label = row.productName || row.asin;
    const exposure = Math.abs(row.salesDelta);
    const share = priorTotal > 0 ? exposure / priorTotal : 0;

    // A stockout is the one cause this report can state on its own evidence:
    // the live snapshot says zero available while the week sold units.
    if (row.stockedOut && (Number(row.recent.units) || 0) > 0) {
      insights.push(makeInsight({
        id: `movers-stockout-${row.asin}`,
        reportKey: "sales-movers",
        reportLabel: SALES_MOVERS_LABEL,
        category: "stockout",
        severity: severityFromExposure({ share: priorTotal > 0 ? (Number(row.recent.sales) || 0) / priorTotal : 0, moneyAtRisk: Number(row.recent.sales) || 0 }),
        title: `${label} sold ${Math.round(Number(row.recent.units) || 0)} units this week but FBA stock is now zero`,
        asin: row.asin, brand: row.brand, entityLabel: label,
        evidence: [
          { label: "Units, last 7 days", value: Math.round(Number(row.recent.units) || 0) },
          { label: "Sales, last 7 days", value: Number(row.recent.sales || 0).toFixed(2) },
          { label: "FBA available", value: 0 },
          { label: "Inbound units", value: Math.round(Number(row.inventory?.inbound) || 0) },
        ],
        moneyAtRisk: Number(row.recent.sales) || 0,
        moneyBasis: "last completed week's sales for this ASIN, which stops if the stockout continues",
        currency,
        confidence: "high",
        freshness: `FBA snapshot ${data.inventorySnapshotDate || "unavailable"} · ${freshness}`,
        why: "The latest FBA Inventory Health snapshot reports zero available units for an ASIN that sold in the most recent completed week.",
        action: (Number(row.inventory?.inbound) || 0) > 0
          ? "Inbound units already exist — confirm the shipment's arrival date and consider expediting."
          : "Create a shipment now; see FBA Shipment Plan for the recommended quantity.",
      }));
    }

    if (row.direction === "decline" && exposure > 0) {
      const driver = row.dominantDriver ? DRIVER_COPY[row.dominantDriver] : null;
      const evidence = [
        { label: "Sales, last 7 days", value: Number(row.recent.sales || 0).toFixed(2) },
        { label: "Sales, prior 7 days", value: Number(row.prior.sales || 0).toFixed(2) },
        { label: "Change", value: `${row.salesDeltaPct === null ? "no prior baseline" : `${row.salesDeltaPct.toFixed(1)}%`}` },
        { label: "Sessions", value: `${Math.round(Number(row.prior.sessions) || 0)} → ${Math.round(Number(row.recent.sessions) || 0)}` },
        { label: "Units per session", value: row.cvrRecent === null || row.cvrPrior === null ? null : `${(row.cvrPrior * 100).toFixed(2)}% → ${(row.cvrRecent * 100).toFixed(2)}%` },
        { label: "Avg selling price", value: row.aspRecent === null || row.aspPrior === null ? null : `${row.aspPrior.toFixed(2)} → ${row.aspRecent.toFixed(2)}` },
        { label: "Ad spend change", value: row.adSpendDelta ? row.adSpendDelta.toFixed(2) : null },
      ];
      insights.push(makeInsight({
        id: `movers-decline-${row.asin}`,
        reportKey: "sales-movers",
        reportLabel: SALES_MOVERS_LABEL,
        category: driver ? `decline-${row.dominantDriver}` : "decline-unattributed",
        severity: severityFromExposure({ share, moneyAtRisk: exposure }),
        title: driver
          ? `${label} sales fell ${exposure.toFixed(0)} week over week, mostly ${driver.label.toLowerCase()}`
          : `${label} sales fell ${exposure.toFixed(0)} week over week`,
        asin: row.asin, brand: row.brand, entityLabel: label,
        evidence,
        moneyAtRisk: exposure,
        moneyBasis: "week-over-week decline in ordered sales for this ASIN",
        currency,
        // Without a computable decomposition the cause is genuinely unknown, so
        // the insight says so and confidence drops rather than naming a driver.
        confidence: driver ? "high" : "low",
        freshness,
        why: driver
          ? `Sales are decomposed exactly into traffic, conversion and price effects; ${driver.why(row)}.`
          : "This ASIN had no sessions or no units in one of the two weeks, so the decline cannot be attributed to traffic, conversion or price from this source.",
        action: driver
          ? driver.action
          : "Open the ASIN in Sales Movers detail and check Buy Box Loss and Listing Health for this SKU before acting.",
      }));
    }

    if (row.direction === "gain" && share >= 0.03) {
      insights.push(makeInsight({
        id: `movers-gain-${row.asin}`,
        reportKey: "sales-movers",
        reportLabel: SALES_MOVERS_LABEL,
        kind: "opportunity",
        category: "gain",
        severity: share >= 0.1 ? "medium" : "low",
        title: `${label} sales grew ${row.salesDelta.toFixed(0)} week over week`,
        asin: row.asin, brand: row.brand, entityLabel: label,
        evidence: [
          { label: "Sales, last 7 days", value: Number(row.recent.sales || 0).toFixed(2) },
          { label: "Sales, prior 7 days", value: Number(row.prior.sales || 0).toFixed(2) },
          { label: "Sessions", value: `${Math.round(Number(row.prior.sessions) || 0)} → ${Math.round(Number(row.recent.sessions) || 0)}` },
          { label: "Days of supply", value: row.inventory?.daysOfSupply ?? null },
        ],
        moneyAtRisk: row.salesDelta,
        moneyBasis: "week-over-week gain in ordered sales, which is what a stockout would forfeit",
        currency,
        confidence: "high",
        freshness,
        why: "This ASIN is one of the largest week-over-week gainers in the selected scope.",
        action: "Protect the win: confirm stock cover in FBA Shipment Plan before scaling ads on it.",
      }));
    }
  }

  return sortInsights(insights);
}

/**
 * The data-completeness guard the DataDoe Sales Movers blueprint calls for. A
 * uniform, traffic-attributed drop across most of the catalogue is far more
 * likely to be an incomplete recent window than a real collapse, and saying so
 * is more useful than a page of false alarms.
 */
export function salesMoversCompletenessWarning(rows) {
  const material = rows.filter((row) => row.direction === "decline" && Math.abs(row.salesDelta) > 0);
  if (material.length < 8) return null;
  const trafficDriven = material.filter((row) => row.dominantDriver === "traffic").length;
  const totalRecentSessions = rows.reduce((sum, row) => sum + (Number(row.recent?.sessions) || 0), 0);
  const totalPriorSessions = rows.reduce((sum, row) => sum + (Number(row.prior?.sessions) || 0), 0);
  const sessionDrop = totalPriorSessions > 0 ? (totalPriorSessions - totalRecentSessions) / totalPriorSessions : 0;
  if (trafficDriven / material.length >= 0.7 && sessionDrop >= 0.4) {
    return `${trafficDriven} of ${material.length} declines are traffic-dominant and account sessions fell ${(sessionDrop * 100).toFixed(0)}% at once. A uniform drop of that shape usually means the most recent days of Sales & Traffic have not finished loading. Re-check after the source catches up before treating this as a real decline.`;
  }
  return null;
}

/* ==================================================================== */
/* Listing Health                                                        */
/* ==================================================================== */

const LISTING_HEALTH_LABEL = "Listing Health";

export const LISTING_GATES = {
  error: { label: "Error", tone: "bad", blurb: "Amazon reports an ERROR-severity issue that blocks or limits this listing." },
  suppressed: { label: "Suppressed", tone: "bad", blurb: "Amazon's listing summary is missing the buyable or discoverable flag." },
  inactive: { label: "Inactive", tone: "bad", blurb: "listing_status is Inactive, so the offer is not selling." },
  incomplete: { label: "Incomplete", tone: "warn", blurb: "listing_status is Incomplete, so required data is missing." },
  stranded: { label: "Stranded stock", tone: "warn", blurb: "Units are on hand but there is no active, buyable offer." },
  no_price: { label: "No price", tone: "warn", blurb: "The listing is Active but carries no positive price." },
  warning: { label: "Warning", tone: "warn", blurb: "Amazon reports a WARNING or INFO issue that can drag performance." },
  ok: { label: "OK", tone: "ok", blurb: "Active, priced, and with no reported issue." },
};

/**
 * Units genuinely on hand for this listing.
 *
 * These fields are different views of the same stock, so they are NEVER added.
 * FBA listings use the inventory snapshot (or the listing's own FBA figure when
 * the snapshot is missing); FBM listings use the merchant quantity.
 */
function unitsOnHand(row) {
  if (row.fulfillmentChannel === "FBM") return Number(row.listingQuantity) || 0;
  if (row.snapshotAvailable !== null && row.snapshotAvailable !== undefined) return Number(row.snapshotAvailable) || 0;
  return Number(row.fbaAvailable) || 0;
}

export function buildListingHealthRows(data, selectedBrand) {
  if (!data || !Array.isArray(data.rows)) return [];
  return data.rows
    .filter((row) => selectedBrand === "ALL" || row.brand === selectedBrand)
    .map((row) => {
      const issues = Array.isArray(row.issues) ? row.issues : [];
      const errors = issues.filter((issue) => issue.severity === "ERROR");
      const warnings = issues.filter((issue) => issue.severity === "WARNING" || issue.severity === "INFO");
      const status = String(row.listingStatus || "");
      const onHand = unitsOnHand(row);
      const isActive = status.toLowerCase() === "active";
      const summary = row.summary || null;
      // Only treat a flag as absent when the source actually reported flags.
      const suppressed = summary && (summary.buyable === false || summary.discoverable === false);
      const noBuyableOffer = row.hasLiveOffer === false;

      let gate = "ok";
      if (errors.length) gate = "error";
      else if (suppressed) gate = "suppressed";
      else if (status === "Inactive") gate = "inactive";
      else if (status === "Incomplete") gate = "incomplete";
      else if (onHand > 0 && (!isActive || noBuyableOffer)) gate = "stranded";
      else if (isActive && (row.price === null || Number(row.price) <= 0)) gate = "no_price";
      else if (warnings.length) gate = "warning";

      return {
        ...row,
        gate,
        gateMeta: LISTING_GATES[gate],
        errors,
        warnings,
        suppressed: Boolean(suppressed),
        noBuyableOffer,
        unitsOnHand: onHand,
        salesAtRisk: gate === "ok" ? 0 : Number(row.sales30d) || 0,
      };
    });
}

export function buildListingHealthInsights(data, rows) {
  if (!data) return [];
  const freshness = freshnessNote({
    sourceLabel: data.sourceLabel,
    asOf: data.asOf,
    extra: data.issuesAvailable ? `listing issues from ${data.issuesSourceLabel}` : "listing issue codes unavailable",
  });
  const totalSales = rows.reduce((sum, row) => sum + (Number(row.sales30d) || 0), 0);
  const insights = [];

  for (const row of rows) {
    if (row.gate === "ok") continue;
    const label = row.productName || row.sku || row.asin;
    const money = Number(row.sales30d) || 0;
    const share = totalSales > 0 ? money / totalSales : 0;
    const blocking = ["error", "suppressed", "inactive"].includes(row.gate);

    // Severity is driven by real exposure: a blocked listing that sold nothing
    // in 30 days is not a high priority, and a warning on a top seller is.
    let severity = severityFromExposure({ share, moneyAtRisk: money });
    if (blocking && money > 0 && severity === "low") severity = "medium";
    if (!blocking && row.gate === "warning") severity = share >= 0.1 ? "medium" : "low";
    if (row.gate === "stranded" && row.unitsOnHand > 0 && severity === "low") severity = "medium";

    const firstError = row.errors[0] || row.warnings[0] || null;
    insights.push(makeInsight({
      id: `listing-${row.gate}-${row.sku || row.asin}`,
      reportKey: "listing-health",
      reportLabel: LISTING_HEALTH_LABEL,
      category: row.gate,
      severity,
      title: row.gate === "stranded"
        ? `${label} holds ${Math.round(row.unitsOnHand)} units with no buyable offer`
        : `${label} is ${row.gateMeta.label.toLowerCase()}${money > 0 ? ` and sold ${money.toFixed(0)} in the last 30 days` : ""}`,
      asin: row.asin, sku: row.sku, brand: row.brand, entityLabel: label,
      evidence: [
        { label: "Listing status", value: row.listingStatus || "unknown" },
        { label: "Fulfilment", value: row.fulfillmentChannel || "unknown" },
        { label: "Price", value: row.price === null ? "none" : Number(row.price).toFixed(2) },
        { label: "Units on hand", value: Math.round(row.unitsOnHand) },
        { label: "Sales, last 30 days", value: money.toFixed(2) },
        { label: "Units, last 30 days", value: Math.round(Number(row.units30d) || 0) },
        { label: "Amazon issue", value: firstError ? `${firstError.severity}${firstError.code ? ` ${firstError.code}` : ""}: ${firstError.message || ""}`.trim() : null },
        { label: "Buyable flag", value: row.summary ? String(row.summary.buyable) : null },
      ],
      moneyAtRisk: money,
      moneyBasis: "trailing 30-day sales for this SKU, which is what stops while the listing is not selling normally",
      currency: row.currency,
      // Without the raw-issues table the gate rests on listing_status alone,
      // which is true but less specific, so confidence is medium not high.
      confidence: data.issuesAvailable ? (firstError ? "high" : "medium") : "medium",
      freshness,
      why: row.gateMeta.blurb,
      action: listingAction(row),
    }));
  }
  return sortInsights(insights);
}

function listingAction(row) {
  switch (row.gate) {
    case "error":
      return `Fix the reported issue in Seller Central${row.errors[0]?.code ? ` (code ${row.errors[0].code})` : ""}, then confirm the listing returns to Active.`;
    case "suppressed":
      return "Open the listing in Seller Central and complete the missing required attributes so it becomes buyable and discoverable again.";
    case "inactive":
      return row.unitsOnHand > 0
        ? "Reactivate the offer — stock is sitting at Amazon while the listing cannot sell."
        : "Decide whether to relist or retire this SKU; it is inactive with no stock behind it.";
    case "incomplete":
      return "Complete the missing required listing data so Amazon can publish the offer.";
    case "stranded":
      return "Resolve the stranded inventory in Seller Central (fix or recreate the offer), or raise a removal order to stop storage cost.";
    case "no_price":
      return "Set a price on this Active listing; without one it cannot win the featured offer.";
    default:
      return "Clear the reported warning when convenient; it is a performance drag rather than a blocker.";
  }
}

/* ==================================================================== */
/* Buy Box Loss                                                          */
/* ==================================================================== */

const BUY_BOX_LABEL = "Buy Box Loss";

export function buildBuyBoxRows(data, selectedBrand, thresholdPct) {
  if (!data || !Array.isArray(data.rows)) return [];
  const threshold = Number.isFinite(thresholdPct) ? thresholdPct : 90;
  return data.rows
    .filter((row) => selectedBrand === "ALL" || row.brand === selectedBrand)
    .map((row) => {
      const buyBoxPct = Number(row.buyBoxPct);
      const lossFraction = Math.max(0, Math.min(1, 1 - buyBoxPct / 100));
      const salesAtRisk = (Number(row.sales) || 0) * lossFraction;
      const effectivePrice = row.price?.salesPrice ?? row.price?.yourPrice ?? null;
      const featured = row.price?.featuredOfferPrice ?? null;
      const lowest = row.price?.lowestPriceNewPlusShipping ?? null;
      const available = row.available;
      const dailyRate = row.unitsShippedT30 ? Number(row.unitsShippedT30) / 30 : null;

      // Cause gates, checked in order, and each one requires its evidence to be
      // present. When nothing is present the cause is explicitly unconfirmed.
      let cause = "unconfirmed";
      let causeDetail = "The price and stock fields needed to explain this loss are not present on the latest FBA snapshot for this SKU.";
      if (effectivePrice !== null && featured !== null && effectivePrice > featured * 1.001) {
        cause = "price";
        causeDetail = `Your offer is ${(effectivePrice - featured).toFixed(2)} above the featured offer price.`;
      } else if (available !== null && available === 0) {
        cause = "stock";
        causeDetail = "The latest FBA snapshot reports zero available units, so the offer cannot be featured.";
      } else if (available !== null && dailyRate !== null && dailyRate > 0 && available < dailyRate * 3) {
        cause = "stock";
        causeDetail = `Only ${Math.round(available)} units are available against a 30-day run rate of ${dailyRate.toFixed(1)} per day.`;
      } else if (effectivePrice !== null && lowest !== null && effectivePrice > lowest * 1.001) {
        cause = "price";
        causeDetail = `Your offer is above the lowest new+shipping price by ${(effectivePrice - lowest).toFixed(2)}.`;
      } else if (!row.inventoryKnown && (Number(row.units) || 0) > 0) {
        cause = "fulfilment";
        causeDetail = "This SKU sold but has no FBA Inventory Health row, which usually means it is merchant-fulfilled; FBM offers lose the featured offer to Prime competitors.";
      }

      return {
        ...row,
        buyBoxPct,
        lossFraction,
        salesAtRisk,
        effectivePrice,
        featuredOfferPrice: featured,
        lowestPrice: lowest,
        priceGap: effectivePrice !== null && featured !== null ? effectivePrice - featured : null,
        dailyRate,
        cause,
        causeDetail,
        belowThreshold: buyBoxPct < threshold,
      };
    });
}

const BUY_BOX_ACTIONS = {
  price: "Reprice to at or below the featured offer, or confirm the margin floor in SKU P&L before matching.",
  stock: "Restock this SKU — the featured offer cannot be won without available units. See FBA Shipment Plan.",
  fulfilment: "Review fulfilment: consider moving this SKU to FBA, or confirm Prime eligibility and handling time for the FBM offer.",
  unconfirmed: "Investigate manually in Seller Central: compare your offer against the current featured offer and confirm stock and fulfilment status.",
};

/* ==================================================================== */
/* Returns & Refund Leakage                                              */
/* ==================================================================== */

const RETURNS_LABEL = "Returns & Refund Leakage";

export const RETURN_BUCKET_META = {
  product_quality: {
    label: "Product / quality",
    lever: "Supplier and QC",
    action: "Raise the defect pattern with the supplier and add an incoming-QC check; re-inspect the current batch before shipping more.",
    actionable: true,
  },
  listing_accuracy: {
    label: "Listing accuracy",
    lever: "Listing content",
    action: "Correct the listing so it matches what ships: fix the wrong attribute, compatibility note, or image that is setting the wrong expectation.",
    actionable: true,
  },
  sizing: {
    label: "Sizing / fit",
    lever: "Size chart and images",
    action: "Add or correct the size chart and add a fit note plus an on-model image; sizing returns fall when expectation is set before purchase.",
    actionable: true,
  },
  delivery: {
    label: "Delivery / fulfilment",
    lever: "Packaging and carrier",
    action: "Review packaging and the carrier for this item; damage and undeliverable returns are a fulfilment fix, not a product fix.",
    actionable: false,
  },
  low_actionability: {
    label: "Low actionability",
    lever: "Usually not fixable",
    action: "Monitor only. These reasons (unwanted, no longer needed, no reason given) rarely respond to a product or listing change.",
    actionable: false,
  },
  other: {
    label: "Other / unclassified",
    lever: "Needs review",
    action: "Open the return reasons for this product in Seller Central; the reported reasons did not map to a known fixable pattern.",
    actionable: false,
  },
};

export function buildReturnsRows(data, selectedBrand) {
  if (!data || !Array.isArray(data.rows)) return [];
  return data.rows
    .filter((row) => selectedBrand === "ALL" || row.brand === selectedBrand)
    .map((row) => {
      // Leakage is the money that actually left: the customer refund plus the
      // seller-borne return fees. COGS on refunded units is reported separately
      // because the source does not say whether that stock came back sellable,
      // and calling it a loss would be an unsupported claim.
      const totalLeakage = (Number(row.refundedAmount) || 0) + (Number(row.returnFees) || 0);

      const unitsShipped = Number(row.unitsShipped) || 0;
      const unitsRefunded = Number(row.unitsRefunded) || 0;
      // A window that catches returns of earlier sales can report more refunded
      // units than shipped units. That is a lag artefact, not a >100% rate, so
      // the rate is withheld and the row is ranked by money instead.
      const lagInflated = unitsShipped > 0 && unitsRefunded > unitsShipped;
      const returnRate = unitsShipped > 0 && !lagInflated ? (unitsRefunded / unitsShipped) * 100 : null;

      const buckets = row.reasonBuckets || {};
      const bucketEntries = Object.entries(buckets).sort((a, b) => b[1] - a[1]);
      const dominantBucket = bucketEntries.length ? bucketEntries[0][0] : null;
      const dominantShare = row.returnCount > 0 && bucketEntries.length
        ? (bucketEntries[0][1] / row.returnCount) * 100
        : null;
      const actionableCount = ["product_quality", "listing_accuracy", "sizing"]
        .reduce((sum, key) => sum + (buckets[key] || 0), 0);

      return {
        ...row,
        totalLeakage,
        returnRate,
        lagInflated,
        dominantBucket,
        dominantBucketMeta: dominantBucket ? RETURN_BUCKET_META[dominantBucket] : null,
        dominantShare,
        actionableCount,
        actionableShare: row.returnCount > 0 ? (actionableCount / row.returnCount) * 100 : null,
      };
    });
}

export function buildReturnsInsights(data, rows) {
  if (!data) return [];
  const freshness = freshnessNote({
    sourceLabel: `${data.returnsSourceLabel} + ${data.moneySourceLabel}`,
    asOf: data.window?.to,
    extra: `${data.window?.days}-day window; return history is limited to about ${data.returnHistoryDays} days`,
  });
  const totalLeakage = rows.reduce((sum, row) => sum + row.totalLeakage, 0);
  const insights = [];

  for (const row of rows) {
    if (row.totalLeakage <= 0 && row.returnCount === 0) continue;
    const label = row.productName || row.sku || row.asin;
    const share = totalLeakage > 0 ? row.totalLeakage / totalLeakage : 0;
    let severity = severityFromExposure({ share, moneyAtRisk: row.totalLeakage });
    // A high return rate on a real volume is a product problem even when the
    // absolute money is mid-sized.
    if (row.returnRate !== null && row.returnRate >= 15 && (row.unitsShipped || 0) >= 20 && severity === "low") {
      severity = "medium";
    }

    const meta = row.dominantBucketMeta;
    // Naming a cause requires a dominant reason bucket that is actually
    // dominant. Below half the returns, the mix is reported without a claim.
    const causeIsClear = Boolean(meta) && row.dominantShare !== null && row.dominantShare >= 50;

    insights.push(makeInsight({
      id: `returns-${row.currency || "na"}-${row.asin}`,
      reportKey: "returns-leakage",
      reportLabel: RETURNS_LABEL,
      category: causeIsClear ? `returns-${row.dominantBucket}` : "returns-mixed",
      severity,
      title: causeIsClear
        ? `${label} lost ${row.totalLeakage.toFixed(0)} to returns, mostly ${meta.label.toLowerCase()}`
        : `${label} lost ${row.totalLeakage.toFixed(0)} to returns across mixed reasons`,
      asin: row.asin, sku: row.sku, brand: row.brand, entityLabel: label,
      evidence: [
        { label: "Refund paid to customers", value: Number(row.refundedAmount || 0).toFixed(2) },
        { label: "Seller-borne return fees", value: Number(row.returnFees || 0).toFixed(2) },
        { label: "Returned items", value: row.returnCount || 0 },
        { label: "Refunded units (settled)", value: Math.round(Number(row.refundedUnitsSettled) || 0) },
        { label: "Units shipped in window", value: row.unitsShipped === null ? null : Math.round(row.unitsShipped) },
        { label: "Return rate", value: row.returnRate === null ? (row.lagInflated ? "withheld — lag artefact" : null) : `${row.returnRate.toFixed(1)}%` },
        { label: "Top reason", value: row.topReasons?.[0] ? `${row.topReasons[0].reason} (${row.topReasons[0].count})` : null },
        { label: "Fixable share of returns", value: row.actionableShare === null ? null : `${row.actionableShare.toFixed(0)}%` },
        { label: "FBA / FBM returns", value: `${row.fbaReturns} / ${row.fbmReturns}` },
        { label: "COGS on refunded units", value: row.cogsOnRefundedUnits ? Number(row.cogsOnRefundedUnits).toFixed(2) : null },
      ],
      moneyAtRisk: row.totalLeakage,
      moneyBasis: `settled customer refunds plus seller-borne return fees over ${data.window?.days} days. COGS on refunded units is shown separately and is NOT included, because the source does not say whether that stock returned sellable`,
      currency: row.currency,
      confidence: !row.hasMoney ? "low" : causeIsClear ? "high" : "medium",
      freshness,
      why: causeIsClear
        ? `${row.dominantShare.toFixed(0)}% of this product's returns give a ${meta.label.toLowerCase()} reason, which is a ${meta.lever.toLowerCase()} problem.`
        : row.returnCount === 0
          ? "Refund settlements exist for this product but the Returns source reported no matching return records in the window, so no reason mix is available."
          : "No single reason accounts for half of this product's returns, so the report does not attribute one cause.",
      action: causeIsClear
        ? meta.action
        : row.returnCount === 0
          ? "Check Seller Central for the return reasons behind these refunds; they may predate this report's return history."
          : "Review the individual return reasons for this product before choosing a fix — the mix is genuinely split.",
    }));
  }

  // One account-level insight when returns are dominated by a fixable cause.
  const bucketTotals = new Map();
  for (const entry of data.reasonTotals || []) {
    bucketTotals.set(entry.bucket, (bucketTotals.get(entry.bucket) || 0) + entry.count);
  }
  const totalReturns = [...bucketTotals.values()].reduce((sum, value) => sum + value, 0);
  const topBucket = [...bucketTotals.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topBucket && totalReturns >= 20 && RETURN_BUCKET_META[topBucket[0]]?.actionable && topBucket[1] / totalReturns >= 0.4) {
    const meta = RETURN_BUCKET_META[topBucket[0]];
    insights.push(makeInsight({
      id: `returns-account-${topBucket[0]}`,
      reportKey: "returns-leakage",
      reportLabel: RETURNS_LABEL,
      category: "returns-account-pattern",
      severity: "medium",
      title: `${((topBucket[1] / totalReturns) * 100).toFixed(0)}% of all returns in this scope are ${meta.label.toLowerCase()}`,
      entityLabel: "Account pattern",
      evidence: [
        { label: "Returned items in window", value: totalReturns },
        { label: `${meta.label} returns`, value: topBucket[1] },
        { label: "Pending return requests", value: data.pendingReturnRequests || 0 },
      ],
      moneyAtRisk: null,
      moneyBasis: null,
      currency: null,
      confidence: "high",
      freshness,
      why: `A single fixable reason bucket accounts for ${((topBucket[1] / totalReturns) * 100).toFixed(0)}% of returns across the whole scope, which points to a systemic cause rather than one bad product.`,
      action: meta.action,
    }));
  }

  return sortInsights(insights);
}

export function buildBuyBoxInsights(data, rows, thresholdPct) {
  if (!data) return [];
  const freshness = freshnessNote({
    sourceLabel: data.sourceLabel,
    asOf: data.observedWindow?.to || data.asOf,
    extra: `prices from the ${data.inventorySnapshotDate || "unavailable"} FBA snapshot`,
  });
  const totalSales = rows.reduce((sum, row) => sum + (Number(row.sales) || 0), 0);
  const insights = [];

  for (const row of rows) {
    if (!row.belowThreshold) continue;
    if (row.salesAtRisk <= 0) continue;
    const label = row.productName || row.sku || row.asin;
    const share = totalSales > 0 ? row.salesAtRisk / totalSales : 0;
    let severity = severityFromExposure({ share, moneyAtRisk: row.salesAtRisk });
    if (row.buyBoxPct < 50 && severity === "low") severity = "medium";

    insights.push(makeInsight({
      id: `buybox-${row.cause}-${row.sku || row.asin}`,
      reportKey: "buy-box-loss",
      reportLabel: BUY_BOX_LABEL,
      category: `buybox-${row.cause}`,
      severity,
      title: `${label} held the Buy Box ${row.buyBoxPct.toFixed(0)}% of the time${row.cause === "unconfirmed" ? "" : ` — likely ${row.cause}`}`,
      asin: row.asin, sku: row.sku, brand: row.brand, entityLabel: label,
      evidence: [
        { label: "Buy Box share", value: `${row.buyBoxPct.toFixed(1)}% (${row.buyBoxBasis}, ${row.buyBoxDays} of ${row.windowDays} days observed)` },
        { label: `Sales, last ${row.windowDays} days`, value: Number(row.sales || 0).toFixed(2) },
        { label: "Your effective price", value: row.effectivePrice === null ? null : row.effectivePrice.toFixed(2) },
        { label: "Featured offer price", value: row.featuredOfferPrice === null ? null : row.featuredOfferPrice.toFixed(2) },
        { label: "Lowest new + shipping", value: row.lowestPrice === null ? null : row.lowestPrice.toFixed(2) },
        { label: "FBA available", value: row.available === null ? null : Math.round(row.available) },
        { label: "30-day run rate", value: row.dailyRate === null ? null : `${row.dailyRate.toFixed(1)} units/day` },
      ],
      moneyAtRisk: row.salesAtRisk,
      moneyBasis: `sales x (1 − Buy Box share) over the last ${row.windowDays} days for this SKU`,
      currency: row.currency,
      confidence: row.cause === "unconfirmed" ? "low" : "high",
      freshness,
      why: `Buy Box share is below the ${thresholdPct}% threshold on a SKU that is still selling. ${row.causeDetail}`,
      action: BUY_BOX_ACTIONS[row.cause],
    }));
  }
  return sortInsights(insights);
}
