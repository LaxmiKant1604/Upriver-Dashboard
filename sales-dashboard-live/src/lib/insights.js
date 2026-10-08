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
import { buildV3Rows } from "./listing-health-v3-view.js";

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
/* FBA stock source (Sales Movers / Buy Box Loss / Listing Health v1)    */
/* ==================================================================== */

// Listings inventory CUTOVER: each insight payload carries ONE per-account stock source
// (lib/server/reports/derivation-core.js insightInventoryFields): the account's validated saved Listings ("Listings
// refreshed <time>"; Listings has no date), else its last SAVED FBA Inventory Health snapshot as a temporary read-only
// BRIDGE (dated by the snapshot, no longer refreshed, never presented as current; the server uses it only while it is
// within 2 days of the report's as-of), else Unavailable. FBA Inventory Health is no longer requested, so its Health-only
// metrics (days of supply, run rate, competitive prices, inbound shipped + received) are never shown. Every stock claim
// is DATED and QUALIFIED:
//   * it names when the stock was observed ("as of <time>" / "as of the saved FBA Inventory Health snapshot of <date>");
//   * a Listings snapshot older than the report's as-of date, and EVERY bridge figure, is qualified "may have changed
//     since" with medium confidence;
//   * no stock claim is made without an observation time.
// The payload model the server stamps (lib/server/reports/inventory-consumer.js INVENTORY_SOURCE_MODEL). A payload
// without it predates phase 2: its stock values are never shown (and never read as 0).
export const INSIGHT_INVENTORY_SOURCE_MODEL = "inventory-source-v1";

// Plain-language reasons (server codes; a "<code>:<count>" suffix is a SKU count).
const INVENTORY_REASON_TEXT = {
  "listings-not-loaded": "this saved snapshot was built without the account's saved Listings",
  "listings-snapshot-missing": "no saved Listings snapshot exists for this account yet",
  "listings-snapshot-read-failed": "the saved Listings snapshot could not be read",
  "listings-snapshot-stale": "the saved Listings snapshot is from an older scheduled run",
  "listings-payload-unreadable": "the saved Listings snapshot could not be read",
  "listings-payload-row-count-mismatch": "the saved Listings snapshot failed its integrity check",
  "listings-identity-unavailable": "this account's saved Listings snapshot could not be identified",
  "listings-empty": "the saved Listings snapshot has no rows for this account",
  "listings-foreign-marketplace-rows": "the saved Listings snapshot contains another marketplace's rows",
  "listings-foreign-seller-rows": "the saved Listings snapshot contains another seller's rows",
  "listings-not-expanded": "the saved Listings snapshot predates the inventory fields",
  "listings-invalid-rows": "the saved Listings snapshot contains rows without a SKU or with an invalid quantity",
  "listings-unresolved-conflicts": "duplicate Listings rows disagree",
  "listings-unattributed-stock": "Listings holds stock on SKUs without an ASIN",
  "listings-blank-fba-fields": "Listings left FBA quantities blank",
  "health-snapshot-empty": "no saved FBA Inventory Health snapshot is available either",
  "health-snapshot-missing": "no saved FBA Inventory Health snapshot is available either",
  "health-snapshot-read-failed": "the saved FBA Inventory Health snapshot could not be read",
  "health-payload-unreadable": "the saved FBA Inventory Health snapshot could not be read",
  "health-payload-row-count-mismatch": "the saved FBA Inventory Health snapshot failed its integrity check",
  "health-payload-malformed": "the saved FBA Inventory Health snapshot failed its integrity check",
  "health-snapshot-identity-mismatch": "the saved FBA Inventory Health snapshot does not belong to this account",
  "health-identity-unavailable": "this account's saved FBA Inventory Health snapshot could not be identified",
  "health-foreign-seller-rows": "the saved FBA Inventory Health snapshot contains another seller's rows",
  "health-foreign-marketplace-rows": "the saved FBA Inventory Health snapshot contains another marketplace's rows",
  "health-bridge-not-loaded": "this saved snapshot was built without the saved FBA Inventory Health snapshot",
  "health-bridge-as-of-missing": "the saved FBA Inventory Health snapshot cannot be checked against a report date",
};
export function inventoryReasonText(code) {
  const raw = String(code || "");
  const [key, count] = raw.split(":");
  // health-bridge-stale:<date> -- the last saved Health snapshot is older than its bridge limit (Health is no longer
  // refreshed), so it drives no figure.
  if (key === "health-bridge-stale") {
    const date = raw.slice(key.length + 1);
    return `the last saved FBA Inventory Health snapshot${/^\d{4}-\d{2}-\d{2}$/.test(date) ? ` (${date})` : ""} is too old to use (FBA Inventory Health is no longer refreshed)`;
  }
  const text = INVENTORY_REASON_TEXT[key] || raw || "the stock source is not available";
  return count && /^\d+$/.test(count) ? `${text} (${count} SKU${count === "1" ? "" : "s"})` : text;
}
const reasonsText = (codes) => (Array.isArray(codes) ? codes : []).map(inventoryReasonText).join("; ");

// An ISO instant -> "YYYY-MM-DD HH:MM UTC" (deterministic, no locale); null when absent or unparseable.
export function fmtListingsRefreshed(value) {
  const t = Date.parse(String(value || ""));
  if (!Number.isFinite(t)) return null;
  return `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// Whole days between an observation day (YYYY-MM-DD) and the report's as-of date; null when either is unknown.
function daysBefore(day, asOf) {
  const a = String(asOf || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "") || !/^\d{4}-\d{2}-\d{2}$/.test(a)) return null;
  return Math.max(0, Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(day + "T00:00:00Z")) / 86400000));
}
// Whole days between the Listings refresh (its UTC date) and the report's as-of date; null when either is unknown.
export function listingsAgeDays(data) {
  const t = Date.parse(String((data && data.listingsRefreshedAt) || ""));
  return Number.isFinite(t) ? daysBefore(new Date(t).toISOString().slice(0, 10), data && data.asOf) : null;
}

/**
 * The FBA stock state of a Sales Movers / Buy Box Loss / Listing Health payload:
 *   { available, legacy, source, sourceShort, label, note, when, ageDays, stale, asOfPhrase }
 * source "listings": when = the Listings refresh time; stale when it is one or more days older than the report's as-of
 *   date (or its age is unknown). source "health-fallback" (the saved FBA Inventory Health BRIDGE): when = the saved
 *   snapshot date; ALWAYS stale (a bridge figure is never presented as current). asOfPhrase qualifies every stock claim;
 *   null when no observation time exists (then no stock claim is made).
 */
export function insightInventoryState(data) {
  if (!data || data.inventoryModel !== INSIGHT_INVENTORY_SOURCE_MODEL) {
    return {
      available: false, legacy: true, source: null, sourceShort: null, label: "FBA stock unavailable",
      note: "This saved snapshot predates the per-account FBA stock source, so its stock values are not shown (never read as 0). A refreshed snapshot shows them with their source.",
      when: null, ageDays: null, stale: true, asOfPhrase: null,
    };
  }
  const source = data.inventorySource;
  if (data.inventoryAvailable !== true || (source !== "listings" && source !== "health-fallback")) {
    const why = reasonsText(data.inventoryUnavailableReasons) || "neither validated Listings nor a usable saved FBA Inventory Health snapshot is available";
    return { available: false, legacy: false, source: "unavailable", sourceShort: null, label: "FBA stock unavailable",
      note: `FBA stock is Unavailable because ${why}. It is never shown as 0.`, when: null, ageDays: null, stale: true, asOfPhrase: null };
  }
  if (source === "listings") {
    const when = fmtListingsRefreshed(data.listingsRefreshedAt);
    const ageDays = when ? listingsAgeDays(data) : null;
    const stale = ageDays === null || ageDays >= 1;
    const age = ageDays === null ? "" : ageDays === 0 ? " (same day as this report)" : ` (${ageDays} day${ageDays === 1 ? "" : "s"} before this report's as-of date)`;
    return {
      available: true, legacy: false, source, sourceShort: "Listings",
      label: when ? `Listings refreshed ${when}${age}` : "Listings refresh time unavailable",
      note: null, when, ageDays, stale,
      asOfPhrase: when ? `as of ${when}${stale ? ", may have changed since" : ""}` : null,
    };
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(data.inventoryHealthDate || "")) ? String(data.inventoryHealthDate) : null;
  const why = reasonsText(data.inventoryFallbackReasons) || "the account's Listings could not be validated";
  return {
    available: true, legacy: false, source, sourceShort: "FBA Inventory Health saved bridge",
    label: `FBA Inventory Health snapshot ${date || "(date unavailable)"} (saved, no longer refreshed — temporary bridge: ${why})`,
    note: `This account's saved Listings could not be used (${why}), so FBA stock comes from its last saved FBA Inventory Health snapshot${date ? ` of ${date}` : ""} — a temporary read-only bridge. FBA Inventory Health is no longer refreshed: those figures are as of that snapshot and may have changed since, and its other metrics (days of supply, run rate, competitive prices) are not shown.`,
    when: date, ageDays: date ? daysBefore(date, data.asOf) : null, stale: true,
    asOfPhrase: date ? `as of the saved FBA Inventory Health snapshot of ${date}, may have changed since` : null,
  };
}

const knownQuantity = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

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
  const stockState = insightInventoryState(data);
  return data.rows
    .filter((row) => selectedBrand === "ALL" || row.brand === selectedBrand)
    .map((sourceRow) => {
      // A pre-phase-2 row's `inventory` (FBA Inventory Health, read as 0 when absent) is dropped here so no consumer --
      // table, CSV, insight, Priority Feed -- can read it.
      const { inventory: _legacyInventory, ...row } = sourceRow;
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

      // The server withholds advertising figures for an ASIN that reported more
      // than one currency, so the delta stays null rather than becoming a
      // meaningless zero.
      const adsMixed = Boolean(row.ads?.mixedCurrency);
      const adSpendDelta = adsMixed ? null : (Number(row.ads?.recentSpend) || 0) - (Number(row.ads?.priorSpend) || 0);
      const adSalesDelta = adsMixed ? null : (Number(row.ads?.recentSales) || 0) - (Number(row.ads?.priorSales) || 0);
      // The account's selected FBA stock source. null = Unavailable (never 0). A merchant-fulfilled ("mfn-only") ASIN, an
      // ASIN absent from the source and a conflicting ASIN are never a stockout: stockedOut is true ONLY for a listed FBA
      // ASIN whose FBA available is a KNOWN 0. No Health-only metric (days of supply, inbound shipped + received) exists:
      // FBA Inventory Health is no longer requested, and a saved-bridge snapshot carries only available + inbound.
      // A pre-cutover snapshot's `stock.health` extras are dropped here so no consumer (table, CSV, insight, feed) reads them.
      const rawStock = stockState.available && row.stock && typeof row.stock === "object" ? row.stock : null;
      const stock = rawStock ? (({ health: _retiredHealthMetrics, ...rest }) => rest)(rawStock) : null;
      const usable = !!stock && stock.listed === true && !stock.conflict;
      const fbaContext = usable ? (stock.fbaContext || null) : null;
      const fbaAvailable = usable && fbaContext === "fba" ? knownQuantity(stock.fbaAvailable) : null;
      const fbaInbound = usable && fbaContext === "fba" ? knownQuantity(stock.fbaInbound) : null;
      const stockedOut = stock ? (usable && fbaContext === "fba" && fbaAvailable === 0) : null;

      return {
        ...row,
        stock,
        stockSource: stockState.available ? stockState.source : null,
        fbaContext,
        fbaAvailable,
        fbaInbound,
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
        adsMixedCurrency: adsMixed,
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
  const stockState = insightInventoryState(data);
  const fallback = stockState.source === "health-fallback";
  const insights = [];

  for (const row of rows) {
    const label = row.productName || row.asin;
    const exposure = Math.abs(row.salesDelta);
    const share = priorTotal > 0 ? exposure / priorTotal : 0;

    // A stockout is the one cause this report can state on its own evidence: the account's stock source reports a
    // KNOWN zero FBA available for a listed FBA ASIN that sold units this week. The claim is DATED (asOfPhrase) and
    // QUALIFIED: a Listings snapshot older than this report, and every saved-bridge figure, "may have changed since"
    // (medium confidence). Unknown / absent / merchant-fulfilled stock never raises it, nor stock with no observation time.
    if (row.stockedOut === true && stockState.available && stockState.asOfPhrase && (Number(row.recent.units) || 0) > 0) {
      const inbound = row.fbaInbound;
      insights.push(makeInsight({
        id: `movers-stockout-${row.asin}`,
        reportKey: "sales-movers",
        reportLabel: SALES_MOVERS_LABEL,
        category: "stockout",
        severity: severityFromExposure({ share: priorTotal > 0 ? (Number(row.recent.sales) || 0) / priorTotal : 0, moneyAtRisk: Number(row.recent.sales) || 0 }),
        title: `${label} sold ${Math.round(Number(row.recent.units) || 0)} units this week; ${stockState.sourceShort} (${stockState.asOfPhrase}) showed zero FBA available`,
        asin: row.asin, brand: row.brand, entityLabel: label,
        evidence: [
          { label: "Units, last 7 days", value: Math.round(Number(row.recent.units) || 0) },
          { label: "Sales, last 7 days", value: Number(row.recent.sales || 0).toFixed(2) },
          { label: `FBA available (${stockState.sourceShort})`, value: 0 },
          fallback
            ? { label: `FBA inbound, working + shipped + received (saved FBA Inventory Health snapshot ${stockState.when})`, value: inbound === null ? null : Math.round(inbound) }
            : { label: "FBA inbound, all inbound states (Listings)", value: inbound === null ? null : Math.round(inbound) },
        ],
        moneyAtRisk: Number(row.recent.sales) || 0,
        moneyBasis: "last completed week's sales for this ASIN, which stops if the stockout continues",
        currency,
        confidence: stockState.stale ? "medium" : "high",
        freshness: `${stockState.label} · ${freshness}`,
        why: fallback
          ? `This account's saved Listings could not be used, so its last saved FBA Inventory Health snapshot (a temporary bridge, no longer refreshed) is the stock source: it reports zero available units (${stockState.asOfPhrase}) for an ASIN that sold in the most recent completed week.`
          : `The account's saved Listings snapshot (${stockState.asOfPhrase}) reports zero FBA available units (fba_quantity_available) for an ASIN that sold in the most recent completed week.`,
        action: fallback
          ? (inbound !== null && inbound > 0
            ? "The saved FBA Inventory Health snapshot showed inbound units — check whether they have arrived since that snapshot (it is no longer refreshed), and expedite if not."
            : "First check whether stock has arrived since the saved FBA Inventory Health snapshot (it is no longer refreshed) and any open inbound shipments in Seller Central, then see FBA Shipment Plan for the recommended quantity.")
          : (inbound !== null && inbound > 0
            ? "Listings shows FBA inbound units (its inbound total covers every inbound state, including shipments not yet shipped) — confirm the shipment's status and arrival date and consider expediting."
            : inbound === 0
              ? "Create a shipment now; see FBA Shipment Plan for the recommended quantity."
              : "Check open inbound shipments in Seller Central, then see FBA Shipment Plan for the recommended quantity."),
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
          { label: `FBA available (${stockState.sourceShort || "unavailable"})`, value: row.fbaAvailable === null || row.fbaAvailable === undefined ? null : Math.round(row.fbaAvailable) },
          // No days-of-supply figure: it was an FBA Inventory Health metric, which is no longer requested.
        ],
        moneyAtRisk: row.salesDelta,
        moneyBasis: "week-over-week gain in ordered sales, which is what a stockout would forfeit",
        currency,
        confidence: "high",
        freshness: row.fbaAvailable === null || row.fbaAvailable === undefined ? freshness : `${freshness} · ${stockState.label}`,
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
 * FBA listings use the account's selected stock source (`onHandFba`: validated
 * saved Listings, else the dated read-only saved FBA Inventory Health bridge); a
 * pre-phase-2 snapshot's Health `snapshotAvailable` and the listing record's own
 * FBA field are never read for it. FBM listings use the merchant quantity. An
 * unknown FBA quantity is null (Unavailable), never 0.
 */
function unitsOnHand(row, stockState) {
  if (row.fulfillmentChannel === "FBM") return Number(row.listingQuantity) || 0;
  if (!stockState || !stockState.available) return null;
  return knownQuantity(row.onHandFba);
}

export function buildListingHealthRows(data, selectedBrand) {
  if (!data || !Array.isArray(data.rows)) return [];
  const stockState = insightInventoryState(data);
  return data.rows
    .filter((row) => selectedBrand === "ALL" || row.brand === selectedBrand)
    .map((sourceRow) => {
      // A pre-phase-2 row's `snapshotAvailable` (FBA Inventory Health, read without a source decision) is dropped.
      const { snapshotAvailable: _legacySnapshotAvailable, ...row } = sourceRow;
      const issues = Array.isArray(row.issues) ? row.issues : [];
      const errors = issues.filter((issue) => issue.severity === "ERROR");
      const warnings = issues.filter((issue) => issue.severity === "WARNING" || issue.severity === "INFO");
      const status = String(row.listingStatus || "");
      const onHand = unitsOnHand(row, stockState);
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
      else if (onHand !== null && onHand > 0 && (!isActive || noBuyableOffer)) gate = "stranded";
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
        // FBA on-hand comes from the account's stock source (dated); FBM from the listing's own merchant quantity.
        unitsOnHandSource: row.fulfillmentChannel === "FBM" ? "merchant" : (onHand === null ? null : stockState.source),
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
  const stockState = insightInventoryState(data);
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
    // FBA on-hand behind a stranded / inactive claim is DATED + QUALIFIED by its source (Listings refresh time or the
    // saved Health bridge's snapshot date); a stale or bridge figure lowers confidence.
    const fbaStockClaim = row.unitsOnHandSource === "listings" || row.unitsOnHandSource === "health-fallback";
    const stockQualifier = fbaStockClaim && stockState.asOfPhrase ? ` (${stockState.sourceShort} ${stockState.asOfPhrase})` : "";
    insights.push(makeInsight({
      id: `listing-${row.gate}-${row.sku || row.asin}`,
      reportKey: "listing-health",
      reportLabel: LISTING_HEALTH_LABEL,
      category: row.gate,
      severity,
      title: row.gate === "stranded"
        ? `${label} holds ${Math.round(row.unitsOnHand)} units with no buyable offer${stockQualifier}`
        : `${label} is ${row.gateMeta.label.toLowerCase()}${money > 0 ? ` and sold ${money.toFixed(0)} in the last 30 days` : ""}`,
      asin: row.asin, sku: row.sku, brand: row.brand, entityLabel: label,
      evidence: [
        { label: "Listing status", value: row.listingStatus || "unknown" },
        { label: "Fulfilment", value: row.fulfillmentChannel || "unknown" },
        { label: "Price", value: row.price === null ? "none" : Number(row.price).toFixed(2) },
        { label: fbaStockClaim ? `Units on hand (FBA, ${stockState.sourceShort})` : "Units on hand", value: row.unitsOnHand === null || row.unitsOnHand === undefined ? null : Math.round(row.unitsOnHand) },
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
      confidence: row.gate === "stranded" && fbaStockClaim && stockState.stale ? "medium" : (data.issuesAvailable ? (firstError ? "high" : "medium") : "medium"),
      freshness: fbaStockClaim ? `${freshness} · ${stockState.label}` : freshness,
      why: row.gate === "stranded" && stockQualifier ? `${row.gateMeta.blurb} On-hand FBA units${stockQualifier}.` : row.gateMeta.blurb,
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

// ---- v3 Listing Health -> Priority Feed adapter (verified v3 findings ONLY; NO legacy v1 reuse) ----------------------
// The Priority Feed's Listing Health alerts come EXCLUSIVELY from the READ-ONLY v3 report through this adapter (the v1
// builders above are never invoked by the feed). It consumes the verified v3 presenter (buildV3Rows) and emits ONLY
// CONFIRMED, ACTIONABLE, CURRENT findings: a gate in the actionable set, evidence that is not stale. It EXCLUDES
// needs_verification / ok (unknown / unavailable / no confirming evidence) and any stale-only finding -- so a feed
// alert is always a real, current problem a user can act on. Resolution is AUTOMATIC: when the durable v3 evidence no
// longer flags a row, this emits nothing for it and the alert disappears on the next feed re-derivation. The feed is
// single-account / single-marketplace, so the shared dedupe key (reportKey|category|asin|sku) is owner+marketplace+
// asin/sku+finding. Reads only the already-loaded durable snapshot -> ZERO DataDoe exports / writes.
export const LHV3_ACTIONABLE_GATES = Object.freeze(["error", "suppressed", "no_live_offer", "no_price", "inactive", "incomplete", "stranded"]);
const LHV3_ACTIONABLE = new Set(LHV3_ACTIONABLE_GATES);
const lhv3Bool = (v) => (v === null || v === undefined ? "Unavailable" : (v ? "Yes" : "No"));

export function buildListingHealthV3Insights(payload, selectedBrand = null) {
  if (!payload || payload.snapshotMissing) return [];
  const rows = buildV3Rows(payload, selectedBrand);
  const asOf = (payload.provenance && payload.provenance.listingsFetchedAt)
    ? String(payload.provenance.listingsFetchedAt).slice(0, 10)
    : (payload.asOf || null);
  const freshness = freshnessNote({
    sourceLabel: "durable OLI window + latest saved listing snapshot",
    asOf,
    extra: payload.issuesAvailable ? null : "Buyable/Discoverable/issue evidence not yet saved",
  });
  // Severity share = an item's exposure as a fraction of the ACCOUNT/brand window sales -- so the denominator is the
  // window sales across ALL rows (not just at-risk rows). Using r.sales (set for every row) mirrors the v1 and Buy Box
  // builders; summing salesAtRisk would collapse the denominator to the at-risk total and over-escalate every alert.
  const totalSales = rows.reduce((sum, r) => sum + (Number(r.sales) || 0), 0);
  const insights = [];
  for (const r of rows) {
    if (!LHV3_ACTIONABLE.has(r.gate)) continue;   // EXCLUDE needs_verification / ok (unknown / unavailable)
    if (r.evidenceStale === true) continue;       // EXCLUDE stale-only findings (evidence >2 days older than as-of)
    const money = Number(r.salesAtRisk) || 0;
    const share = totalSales > 0 ? money / totalSales : 0;
    const tone = (r.gateMeta && r.gateMeta.tone) || "warn";
    let severity = severityFromExposure({ share, moneyAtRisk: money });
    if (tone === "bad" && severity === "low") severity = "medium"; // a confirmed blocker is never "low"
    const finding = (r.gateMeta && r.gateMeta.label) || r.gate;
    const label = r.productName || r.sku || r.asin;
    insights.push(makeInsight({
      id: `lhv3-${r.gate}-${r.sku || r.asin}`,
      reportKey: "listing-health-v3",
      reportLabel: "Listing Health",
      kind: "risk",
      severity,
      category: r.gate,
      title: `${label} — ${finding}${money > 0 ? ` (${money.toFixed(0)} at risk)` : ""}`,
      asin: r.asin, sku: r.sku, brand: r.brand, entityLabel: label,
      evidence: [
        { label: "Account", value: payload.accountId || "" },
        { label: "Marketplace", value: payload.marketplace || "" },
        { label: "Amazon Listing Status", value: r.listingStatus || "Unavailable" },
        { label: "Health Finding", value: finding },
        { label: "Buyable", value: lhv3Bool(r.buyable) },
        { label: "Discoverable", value: lhv3Bool(r.discoverable) },
        { label: "Live offer", value: lhv3Bool(r.liveOffer) },
        { label: "Evidence source", value: r.evidenceSource || "Unavailable" },
        { label: "Evidence as of", value: r.evidenceAsOf || "Unavailable" },
        { label: "Sales at risk", value: money.toFixed(2) },
      ],
      moneyAtRisk: money,
      moneyBasis: "selected-window sales exposure for a listing flagged now (not proven lost revenue)",
      currency: r.currency,
      confidence: r.confidence === "confirmed" ? "high" : "medium",
      freshness,
      why: r.whyFlagged,
      action: r.recommendedAction,
    }));
  }
  return sortInsights(insights);
}

/* ==================================================================== */
/* Buy Box Loss                                                          */
/* ==================================================================== */

const BUY_BOX_LABEL = "Buy Box Loss";

// Buy Box cause attribution from the account's selected stock source (Listings inventory cutover):
//   Listings source  -- stock: an FBA-channel SKU whose fba_quantity_available is a KNOWN 0; fulfilment:
//                       listing_fulfillment_channel DEFAULT (merchant-fulfilled).
//   saved Health bridge -- the last saved FBA Inventory Health snapshot (a temporary read-only bridge, DATED and
//                       QUALIFIED): stock (a known zero available on a SKU it lists), and fulfilment only when the
//                       account's Listings prove the SKU merchant-fulfilled only (a SKU absent from Health is unknown --
//                       never inferred FBM).
//   otherwise        -- unconfirmed. A SKU absent from the source, a conflicting SKU or an unknown quantity is NEVER read as
//                       merchant-fulfilled or out of stock.
// Competitive prices and the 30-day run rate were FBA Inventory Health metrics: FBA Inventory Health is no longer
// requested, so NO price cause (and no low-stock-vs-run-rate cause) is evaluated, and no Listings price is substituted.
const PRICE_NOT_EVALUATED_NOTE = "Competitive prices are not evaluated: they came from FBA Inventory Health, which is no longer refreshed (no Listings price is substituted).";

export function buildBuyBoxRows(data, selectedBrand, thresholdPct) {
  if (!data || !Array.isArray(data.rows)) return [];
  const threshold = Number.isFinite(thresholdPct) ? thresholdPct : 90;
  const stockState = insightInventoryState(data);
  const fallback = stockState.source === "health-fallback";
  return data.rows
    .filter((row) => selectedBrand === "ALL" || row.brand === selectedBrand)
    .map((sourceRow) => {
      // A pre-phase-2 row's FBA Inventory Health fields (read without a source decision) are dropped so no consumer
      // (table, CSV, insight, Priority Feed) can read them.
      const {
        price: _legacyPrice, available: _legacyAvailable, unitsShippedT30: _legacyRunRate, inventoryKnown: _legacyKnown,
        ...row
      } = sourceRow;
      const buyBoxPct = Number(row.buyBoxPct);
      const lossFraction = Math.max(0, Math.min(1, 1 - buyBoxPct / 100));
      const salesAtRisk = (Number(row.sales) || 0) * lossFraction;
      // A pre-cutover snapshot's `stock.health` (competitive prices / run rate) is dropped: never shown, never a cause.
      const rawStock = stockState.available && row.stock && typeof row.stock === "object" ? row.stock : null;
      const stock = rawStock ? (({ health: _retiredHealthMetrics, ...rest }) => rest)(rawStock) : null;
      const usable = !!stock && stock.listed === true && !stock.conflict;
      const channel = usable && stock.channel ? String(stock.channel).toUpperCase() : null;
      const mfnOnly = usable && stock.fbaContext === "mfn-only";
      const fulfillmentChannel = mfnOnly ? "FBM" : (channel ? (channel === "DEFAULT" ? "FBM" : "FBA") : null);
      const fbaAvailable = usable && stock.fbaContext === "fba" ? knownQuantity(stock.fbaAvailable) : null;
      const per = `Per the saved FBA Inventory Health snapshot${stockState.when ? ` of ${stockState.when}` : ""} (a temporary bridge; may have changed since)`;
      // An FBA SKU: a Listings non-DEFAULT channel, or any SKU the saved Health bridge lists (Health lists FBA inventory).
      const fbaSku = usable && stock.fbaContext === "fba" && (fallback || (channel && channel !== "DEFAULT"));

      let cause = "unconfirmed";
      let causeDetail;
      if (!stock) {
        causeDetail = stockState.legacy
          ? "This saved snapshot predates the per-account stock source, so no cause is named."
          : `Stock and fulfilment evidence is unavailable for this account (${stockState.note || "no stock source"}), so no cause is named. ${PRICE_NOT_EVALUATED_NOTE}`;
      } else if (!stock.listed) {
        causeDetail = `This SKU is not in the account's ${fallback ? "saved FBA Inventory Health snapshot" : "saved Listings snapshot"}, so its stock and fulfilment channel are unknown; no cause is named. ${PRICE_NOT_EVALUATED_NOTE}`;
      } else if (stock.conflict) {
        causeDetail = `This SKU's Listings rows disagree, so its stock and fulfilment channel are Unavailable; no cause is named. ${PRICE_NOT_EVALUATED_NOTE}`;
      } else if (fbaSku && fbaAvailable === 0 && !stockState.asOfPhrase) {
        causeDetail = `The stock source reports zero FBA available units for this SKU but carries no observation time, so no stock cause is named. ${PRICE_NOT_EVALUATED_NOTE}`;
      } else if (fbaSku && fbaAvailable === 0) {
        cause = "stock";
        causeDetail = `${stockState.sourceShort} (${stockState.asOfPhrase}) reports zero FBA available units for this FBA SKU, so the offer could not be featured then.`;
      } else if (mfnOnly || (!fallback && channel === "DEFAULT")) {
        cause = "fulfilment";
        causeDetail = mfnOnly && fallback
          ? "The account's Listings report this SKU as merchant-fulfilled only (no FBA stock); merchant-fulfilled offers often lose the featured offer to Prime (FBA) offers."
          : "Listings reports this SKU's fulfillment channel as DEFAULT (merchant-fulfilled); merchant-fulfilled offers often lose the featured offer to Prime (FBA) offers.";
      } else if (!fallback && !channel) {
        causeDetail = `Listings does not report this SKU's fulfillment channel, so no cause is named. ${PRICE_NOT_EVALUATED_NOTE}`;
      } else if (fbaAvailable === null) {
        causeDetail = `This SKU's FBA available quantity is Unavailable in its stock source, so no cause is named. ${PRICE_NOT_EVALUATED_NOTE}`;
      } else {
        causeDetail = fallback
          ? `${per}, ${Math.round(fbaAvailable)} FBA units were available, so stock does not explain the loss. ${PRICE_NOT_EVALUATED_NOTE}`
          : `Listings shows ${Math.round(fbaAvailable)} FBA available units (${stockState.asOfPhrase || "refresh time unavailable"}), so stock does not explain the loss. ${PRICE_NOT_EVALUATED_NOTE}`;
      }

      return {
        ...row,
        buyBoxPct,
        lossFraction,
        salesAtRisk,
        stock,
        stockSource: stockState.available ? stockState.source : null,
        fbaAvailable,
        fulfillmentChannel,
        cause,
        causeDetail,
        belowThreshold: buyBoxPct < threshold,
      };
    });
}

const BUY_BOX_ACTIONS = {
  stock: "Restock this SKU — the featured offer cannot be won without available units. See FBA Shipment Plan.",
  fulfilment: "Review fulfilment: consider moving this SKU to FBA, or confirm Prime eligibility and handling time for the FBM offer.",
  unconfirmed: "Investigate manually in Seller Central: compare your offer and price against the current featured offer and confirm stock and fulfilment status.",
};

/* ==================================================================== */
/* Listing & Search Optimizer                                            */
/* ==================================================================== */

const OPTIMIZER_LABEL = "Listing & Search Optimizer";

// Amazon's 2026 title rule for non-media categories.
export const TITLE_MAX_CHARS = 75;
const PROMOTIONAL_WORDS = /\b(best|best[- ]seller|sale|cheap|free shipping|hot|new|#1|number one|top rated|guaranteed|discount|deal)\b/i;
// Symbols Amazon disallows in titles unless part of a brand name.
const BANNED_TITLE_SYMBOLS = /[!$?_{}^¬¦]/;

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "of", "to", "in", "on", "at", "by",
  "from", "is", "it", "as", "be", "are", "this", "that", "your", "you", "my", "our",
]);

function tokenise(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

/**
 * Per-query funnel metrics, each derived from summed counts so nothing is an
 * average of averages. Market rates are the whole query's rates and are what
 * make "below market" a measurement rather than a guess.
 */
export function optimizerQueryMetrics(query) {
  const impressionShare = ratio(query.asinImpressions, query.totalImpressions);
  const yourCtr = ratio(query.asinClicks, query.asinImpressions);
  const marketCtr = ratio(query.totalClicks, query.totalImpressions);
  const yourCvr = ratio(query.asinPurchases, query.asinClicks);
  const marketCvr = ratio(query.totalPurchases, query.totalClicks);
  const cartRate = ratio(query.asinCartAdds, query.asinClicks);
  const marketCartRate = ratio(query.totalCartAdds, query.totalClicks);
  const purchaseShare = ratio(query.asinPurchases, query.totalPurchases);
  return {
    ...query,
    impressionShare,
    yourCtr, marketCtr,
    ctrVsMarket: yourCtr !== null && marketCtr !== null && marketCtr > 0 ? yourCtr / marketCtr : null,
    yourCvr, marketCvr,
    cvrVsMarket: yourCvr !== null && marketCvr !== null && marketCvr > 0 ? yourCvr / marketCvr : null,
    cartRate, marketCartRate,
    purchaseShare,
  };
}

export const OPTIMIZER_GATES = {
  relevance: {
    label: "Probably not your product",
    tone: "ok",
    why: "Low impression share with both click-through AND conversion below the market rate for this query. That pattern means shoppers on this term do not want this product.",
    action: "Do not chase this term. Spending on it or adding it to the listing would import irrelevant traffic.",
  },
  discoverability: {
    label: "Not indexed well",
    tone: "warn",
    why: "The query has real volume and this ASIN converts at or above the market rate, but its impression share is low and its best organic rank is weak. Amazon is not showing it for a term it wins when shown.",
    action: "Add this term to the listing where it is genuinely accurate — title if it is the primary term, otherwise a bullet or a structured attribute.",
  },
  exposure: {
    label: "Needs rank or ads",
    tone: "warn",
    why: "Click-through and conversion are at or above market, so the copy is not the problem — only exposure is.",
    action: "Push exposure rather than rewriting copy: raise rank with ads on this term and protect stock and Buy Box.",
  },
  click_rate: {
    label: "Click-through below market",
    tone: "warn",
    why: "This ASIN gets impressions on the query but is clicked less often than the query average, which is a main-image, title or price signal.",
    action: "Test the main image and the front of the title for this term, and check the price against the featured offer.",
  },
  conversion: {
    label: "Conversion below market",
    tone: "bad",
    why: "Shoppers click this ASIN at or above the market rate and then do not buy, which is an offer-page problem rather than a discovery problem.",
    action: "Work the offer page: bullets, A+ content, images, reviews and price. Check the cart-add rate to see whether shoppers drop before or after the cart.",
  },
  strong: {
    label: "Winning",
    tone: "ok",
    why: "Impression share, click-through and conversion are all at or above the market rate for this query.",
    action: "Protect it: keep stock and Buy Box, and keep the term in the listing.",
  },
};

/**
 * Classify one query, in the blueprint's order. Each gate needs both sides of a
 * comparison to exist; a query without market denominators is left unclassified
 * rather than being forced into a bucket.
 */
export function classifyOptimizerQuery(metrics, { lowShare = 0.1, weakRank = 20 } = {}) {
  const { impressionShare, ctrVsMarket, cvrVsMarket, bestRank } = metrics;
  if (impressionShare === null || ctrVsMarket === null || cvrVsMarket === null) return null;
  const lowExposure = impressionShare < lowShare;
  const weakCtr = ctrVsMarket < 0.8;
  const weakCvr = cvrVsMarket < 0.8;

  if (lowExposure && weakCtr && weakCvr) return "relevance";
  if (lowExposure && !weakCvr && (bestRank === null || bestRank > weakRank)) return "discoverability";
  if (lowExposure && !weakCtr && !weakCvr) return "exposure";
  if (weakCtr) return "click_rate";
  if (weakCvr) return "conversion";
  return "strong";
}

/** Deterministic title checks against Amazon's published 2026 title rules. */
export function auditTitle(title) {
  const text = String(title || "");
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const counts = new Map();
  words.forEach((word) => {
    if (STOP_WORDS.has(word)) return;
    counts.set(word, (counts.get(word) || 0) + 1);
  });
  const repeated = [...counts.entries()].filter(([, count]) => count > 2).map(([word]) => word);
  const promotional = text.match(PROMOTIONAL_WORDS);
  const bannedSymbol = text.match(BANNED_TITLE_SYMBOLS);
  return {
    length: text.length,
    overLength: text.length > TITLE_MAX_CHARS,
    repeatedWords: repeated,
    promotionalWord: promotional ? promotional[0] : null,
    bannedSymbol: bannedSymbol ? bannedSymbol[0] : null,
    missing: text.trim().length === 0,
  };
}

/**
 * Build one row per ASIN: the funnel gates its queries fall into, its content
 * gaps, and the money keywords whose terms are missing from the listing.
 */
export function buildOptimizerRows(data, selectedBrand) {
  if (!data || !data.sqpAvailable) return [];
  const productByAsin = new Map((data.products || []).map((product) => [product.asin, product]));
  const byAsin = new Map();

  for (const rawQuery of data.queries || []) {
    const product = productByAsin.get(rawQuery.asin) || { asin: rawQuery.asin, name: null, brand: "Unassigned", bullets: [], description: null, hasImage: false };
    if (selectedBrand !== "ALL" && product.brand !== selectedBrand) continue;
    const metrics = optimizerQueryMetrics(rawQuery);
    const gate = classifyOptimizerQuery(metrics);

    let entry = byAsin.get(rawQuery.asin);
    if (!entry) {
      const listingText = [product.name, ...(product.bullets || []), product.description].filter(Boolean).join(" ").toLowerCase();
      entry = {
        asin: rawQuery.asin,
        productName: product.name,
        brand: product.brand,
        category: product.category || null,
        bestSellerRank: product.bestSellerRank || null,
        bulletCount: (product.bullets || []).length,
        hasDescription: Boolean(product.description),
        hasImage: Boolean(product.hasImage),
        title: product.name,
        titleAudit: auditTitle(product.name),
        listingText,
        queries: [],
        gateCounts: {},
        volume: 0,
        purchases: 0,
        clicks: 0,
        impressions: 0,
      };
      byAsin.set(rawQuery.asin, entry);
    }
    entry.queries.push({ ...metrics, gate });
    if (gate) entry.gateCounts[gate] = (entry.gateCounts[gate] || 0) + 1;
    entry.volume += Number(rawQuery.volume) || 0;
    entry.purchases += Number(rawQuery.asinPurchases) || 0;
    entry.clicks += Number(rawQuery.asinClicks) || 0;
    entry.impressions += Number(rawQuery.asinImpressions) || 0;
  }

  return [...byAsin.values()].map((entry) => {
    // Money keywords: queries that actually converted for this ASIN, ranked by
    // the purchases they produced.
    const moneyQueries = entry.queries
      .filter((query) => query.asinPurchases > 0)
      .sort((a, b) => b.asinPurchases - a.asinPurchases);

    // A keyword gap is a token from a converting query that appears nowhere in
    // the title, bullets or description. This is a coverage fact, not a
    // suggestion to stuff the listing.
    const gaps = new Map();
    for (const query of moneyQueries) {
      for (const token of tokenise(query.query)) {
        if (entry.listingText.includes(token)) continue;
        const current = gaps.get(token) || { token, purchases: 0, volume: 0, queries: [] };
        current.purchases += query.asinPurchases;
        current.volume += query.volume;
        if (current.queries.length < 3) current.queries.push(query.query);
        gaps.set(token, current);
      }
    }
    const keywordGaps = [...gaps.values()].sort((a, b) => b.purchases - a.purchases).slice(0, 12);

    // The single most important query is the biggest converter; whether it is in
    // the title is the highest-leverage yes/no in the whole report.
    const topQuery = moneyQueries[0] || null;
    const topQueryInTitle = topQuery && entry.title
      ? tokenise(topQuery.query).every((token) => String(entry.title).toLowerCase().includes(token))
      : null;

    const contentIssues = [];
    if (entry.titleAudit.missing) contentIssues.push("No title in the catalog record");
    if (entry.titleAudit.overLength) contentIssues.push(`Title is ${entry.titleAudit.length} characters, over Amazon's ${TITLE_MAX_CHARS}-character limit`);
    if (entry.titleAudit.promotionalWord) contentIssues.push(`Title contains the promotional word "${entry.titleAudit.promotionalWord}"`);
    if (entry.titleAudit.bannedSymbol) contentIssues.push(`Title contains the disallowed symbol "${entry.titleAudit.bannedSymbol}"`);
    if (entry.titleAudit.repeatedWords.length) contentIssues.push(`Title repeats ${entry.titleAudit.repeatedWords.join(", ")} more than twice`);
    if (entry.bulletCount < 5) contentIssues.push(`Only ${entry.bulletCount} of 5 bullet points are filled`);
    if (!entry.hasDescription) contentIssues.push("No product description");
    if (!entry.hasImage) contentIssues.push("No main image URL in the catalog record");

    const dominantGate = Object.entries(entry.gateCounts).sort((a, b) => b[1] - a[1])[0] || null;

    return {
      ...entry,
      queryCount: entry.queries.length,
      moneyQueryCount: moneyQueries.length,
      topQuery,
      topQueryInTitle,
      keywordGaps,
      contentIssues,
      dominantGate: dominantGate ? dominantGate[0] : null,
      dominantGateMeta: dominantGate ? OPTIMIZER_GATES[dominantGate[0]] : null,
      // Scope-level funnel rates, recomputed from the summed counts.
      ctr: ratio(entry.clicks, entry.impressions),
      cvr: ratio(entry.purchases, entry.clicks),
    };
  });
}

export function buildOptimizerInsights(data, rows) {
  if (!data || !data.sqpAvailable) return [];
  const freshness = freshnessNote({
    sourceLabel: data.sqpSourceLabel,
    asOf: data.periods?.[data.periods.length - 1],
    extra: `${data.periodCount} weekly period${data.periodCount === 1 ? "" : "s"} in a ${data.window?.days}-day window`,
  });
  const insights = [];

  for (const row of rows) {
    const label = row.productName || row.asin;

    // The single highest-leverage finding in the blueprint: the best-converting
    // query is not in the title.
    if (row.topQuery && row.topQueryInTitle === false) {
      insights.push(makeInsight({
        id: `optimizer-title-${row.asin}`,
        reportKey: "listing-optimizer",
        reportLabel: OPTIMIZER_LABEL,
        category: "optimizer-title-gap",
        severity: row.topQuery.asinPurchases >= 10 ? "high" : "medium",
        title: `${label}: its best-converting search term "${row.topQuery.query}" is not in the title`,
        asin: row.asin, brand: row.brand, entityLabel: label,
        evidence: [
          { label: "Search term", value: row.topQuery.query },
          { label: "Purchases from this term", value: Math.round(row.topQuery.asinPurchases) },
          { label: "Query volume", value: Math.round(row.topQuery.volume) },
          { label: "Your impression share", value: row.topQuery.impressionShare === null ? null : `${(row.topQuery.impressionShare * 100).toFixed(1)}%` },
          { label: "Your CVR vs market", value: row.topQuery.cvrVsMarket === null ? null : `${row.topQuery.cvrVsMarket.toFixed(2)}x` },
          { label: "Title length", value: `${row.titleAudit.length} / ${TITLE_MAX_CHARS} characters` },
        ],
        // No monetary basis: SQP reports purchase counts, not revenue, and
        // inventing a price to multiply by would be fabrication.
        moneyAtRisk: null,
        moneyBasis: null,
        confidence: "high",
        freshness,
        why: `This term already produced ${Math.round(row.topQuery.asinPurchases)} purchases for this ASIN, yet its words do not all appear in the title, which is the strongest relevance signal Amazon reads.`,
        action: row.titleAudit.overLength
          ? `Rework the title to include this term while cutting it to ${TITLE_MAX_CHARS} characters — it is currently ${row.titleAudit.length}. Review the wording yourself; this report does not rewrite listings.`
          : "Add this term near the front of the title, after the brand. Review the wording yourself; this report does not rewrite listings.",
      }));
    }

    if (row.contentIssues.length) {
      const blocking = row.contentIssues.some((issue) => /over Amazon's|No title|No main image/.test(issue));
      insights.push(makeInsight({
        id: `optimizer-content-${row.asin}`,
        reportKey: "listing-optimizer",
        reportLabel: OPTIMIZER_LABEL,
        category: "optimizer-content",
        severity: blocking ? "medium" : "low",
        title: `${label} has ${row.contentIssues.length} listing content gap${row.contentIssues.length === 1 ? "" : "s"}`,
        asin: row.asin, brand: row.brand, entityLabel: label,
        evidence: [
          ...row.contentIssues.slice(0, 5).map((issue, index) => ({ label: `Issue ${index + 1}`, value: issue })),
          { label: "Bullets filled", value: `${row.bulletCount} of 5` },
          { label: "Queries seen", value: row.queryCount },
        ],
        moneyAtRisk: null,
        moneyBasis: null,
        confidence: "high",
        freshness: freshnessNote({ sourceLabel: data.contentSourceLabel, asOf: data.asOf }),
        why: "These are measured properties of the listing record itself: a character count, a missing field, or a rule Amazon publishes.",
        action: "Fill the missing fields and bring the title inside Amazon's character limit. Every change is made by you in Seller Central; this report only measures.",
      }));
    }

    if (row.keywordGaps.length >= 3 && row.moneyQueryCount >= 3) {
      insights.push(makeInsight({
        id: `optimizer-gaps-${row.asin}`,
        reportKey: "listing-optimizer",
        reportLabel: OPTIMIZER_LABEL,
        category: "optimizer-keyword-gap",
        severity: "low",
        title: `${label} converts on ${row.keywordGaps.length} words that appear nowhere in its listing`,
        asin: row.asin, brand: row.brand, entityLabel: label,
        evidence: [
          { label: "Missing words", value: row.keywordGaps.slice(0, 6).map((gap) => gap.token).join(", ") },
          { label: "Purchases behind them", value: Math.round(row.keywordGaps.reduce((sum, gap) => sum + gap.purchases, 0)) },
          { label: "Example queries", value: row.keywordGaps[0]?.queries?.join(" / ") || null },
        ],
        moneyAtRisk: null,
        moneyBasis: null,
        confidence: "medium",
        freshness,
        why: "These words appear in queries that produced purchases for this ASIN but appear in neither the title, the bullets nor the description.",
        action: "Add the words that are genuinely accurate for this product to a bullet or a structured attribute. Do not add a word that does not describe it, and do not repeat words to stuff the listing.",
      }));
    }

    const dominant = row.dominantGateMeta;
    if (dominant && ["conversion", "click_rate"].includes(row.dominantGate)) {
      insights.push(makeInsight({
        id: `optimizer-funnel-${row.asin}`,
        reportKey: "listing-optimizer",
        reportLabel: OPTIMIZER_LABEL,
        category: `optimizer-${row.dominantGate}`,
        severity: row.dominantGate === "conversion" ? "medium" : "low",
        title: `${label}: ${dominant.label.toLowerCase()} on ${row.gateCounts[row.dominantGate]} of ${row.queryCount} search queries`,
        asin: row.asin, brand: row.brand, entityLabel: label,
        evidence: [
          { label: "Queries in this state", value: `${row.gateCounts[row.dominantGate]} of ${row.queryCount}` },
          { label: "Your CTR (all queries)", value: row.ctr === null ? null : `${(row.ctr * 100).toFixed(2)}%` },
          { label: "Your CVR (all queries)", value: row.cvr === null ? null : `${(row.cvr * 100).toFixed(1)}%` },
          { label: "Cart-add rate on top query", value: row.topQuery?.cartRate === null || !row.topQuery ? null : `${(row.topQuery.cartRate * 100).toFixed(1)}%` },
          { label: "Bullets filled", value: `${row.bulletCount} of 5` },
        ],
        moneyAtRisk: null,
        moneyBasis: null,
        confidence: "high",
        freshness,
        why: dominant.why,
        action: dominant.action,
      }));
    }
  }

  return sortInsights(insights);
}

/* ==================================================================== */
/* PPC Performance & Wasted Spend                                        */
/* ==================================================================== */

const PPC_LABEL = "PPC Performance";

/**
 * Derive every advertising ratio from the summed numerators and denominators.
 * ACoS, CTR, CVR and CPC are never summed or averaged from per-row ratios.
 */
export function ppcMetrics(row, { totalSales } = {}) {
  const spend = Number(row.spend) || 0;
  const sales = Number(row.sales) || 0;
  const clicks = Number(row.clicks) || 0;
  const impressions = Number(row.impressions) || 0;
  const orders = Number(row.orders) || 0;
  return {
    ...row,
    spend, sales, clicks, impressions, orders,
    units: Number(row.units) || 0,
    acos: sales > 0 ? (spend / sales) * 100 : null,
    roas: spend > 0 ? sales / spend : null,
    // TACoS needs account total sales, which no Ads table carries.
    tacos: totalSales && totalSales > 0 ? (spend / totalSales) * 100 : null,
    cpc: clicks > 0 ? spend / clicks : null,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    cvr: clicks > 0 ? (orders / clicks) * 100 : null,
    aov: orders > 0 ? sales / orders : null,
  };
}

/**
 * Wasted spend, split into the two kinds that need different actions.
 *
 *  * Dead spend — clicks with zero attributed orders, above a minimum click
 *    count so a small sample is not called waste. All of the spend is waste.
 *  * Break-even breach — the row converts, but its ACoS is above the
 *    break-even target. Only the spend ABOVE break-even is waste, not the whole
 *    spend, because the row is still producing profitable sales up to that point.
 */
export function ppcWaste(row, breakEvenAcos, minClicks) {
  const spend = Number(row.spend) || 0;
  const sales = Number(row.sales) || 0;
  const clicks = Number(row.clicks) || 0;
  const orders = Number(row.orders) || 0;

  if (orders === 0 && clicks >= minClicks) {
    return { kind: "dead", wasted: spend, note: `${clicks} clicks and no attributed orders` };
  }
  if (orders === 0) {
    return { kind: "watch", wasted: 0, note: `only ${clicks} click${clicks === 1 ? "" : "s"} so far — too small a sample to call waste` };
  }
  const acos = sales > 0 ? (spend / sales) * 100 : null;
  if (acos !== null && acos > breakEvenAcos) {
    const breakEvenSpend = sales * (breakEvenAcos / 100);
    return { kind: "breach", wasted: Math.max(0, spend - breakEvenSpend), note: `ACoS ${acos.toFixed(1)}% against a ${breakEvenAcos}% break-even` };
  }
  if (acos !== null && acos <= breakEvenAcos * 0.6 && orders >= 3) {
    return { kind: "scale", wasted: 0, note: `ACoS ${acos.toFixed(1)}% is well inside the ${breakEvenAcos}% break-even` };
  }
  return { kind: "ok", wasted: 0, note: acos === null ? "no attributed sales" : `ACoS ${acos.toFixed(1)}%` };
}

export const PPC_WASTE_META = {
  dead: { label: "Dead spend", tone: "bad" },
  breach: { label: "Break-even breach", tone: "warn" },
  scale: { label: "Scaling candidate", tone: "ok" },
  watch: { label: "Small sample", tone: "ok" },
  ok: { label: "Within target", tone: "ok" },
};

export function buildPpcRows(data, level, { breakEvenAcos, selectedBrand }) {
  if (!data) return [];
  const source = data[level] || [];
  const minClicks = data.minClicksForWaste || 10;
  return source
    // Only the ASIN level carries a brand, so the shared header brand filter
    // applies there. Campaign, target and search-term rows are not
    // brand-attributable, and filtering them by brand would silently hide
    // spend, so they are left unfiltered and the UI says so.
    .filter((row) => level !== "asins" || selectedBrand === "ALL" || row.brand === selectedBrand)
    .map((row) => {
      const metrics = ppcMetrics(row, { totalSales: data.totalSales });
      const waste = ppcWaste(metrics, breakEvenAcos, minClicks);
      return { ...metrics, waste, wasteMeta: PPC_WASTE_META[waste.kind] };
    });
}

export function buildPpcInsights(data, rows, level, breakEvenAcos) {
  if (!data) return [];
  const coverage = data.sourceAvailability?.find((entry) => entry.key?.startsWith(
    level === "searchTerms" ? "search-terms" : level === "targets" ? "keyword-targeting" : level === "asins" ? "asin" : "campaign"
  ));
  const freshness = freshnessNote({
    sourceLabel: coverage?.label || "Persisted Amazon Ads history",
    asOf: data.latestMetricDate,
    extra: `${data.window?.days}-day window · ${coverage?.coverage || ""}`.trim(),
  });
  const totalSpend = rows.reduce((sum, row) => sum + row.spend, 0);
  const insights = [];

  for (const row of rows) {
    const label = row.searchTerm || row.targetText || row.campaignName || row.productName || row.asin || row.campaignId;
    if (!label) continue;
    const currency = row.currencies?.[0] || null;
    const entityAsin = level === "asins" ? row.asin : null;

    if (row.waste.kind === "dead") {
      const share = totalSpend > 0 ? row.waste.wasted / totalSpend : 0;
      insights.push(makeInsight({
        id: `ppc-dead-${level}-${row.key}`,
        reportKey: "ppc-performance",
        reportLabel: PPC_LABEL,
        category: "ppc-dead-spend",
        severity: severityFromExposure({ share, moneyAtRisk: row.waste.wasted }),
        title: `"${label}" spent ${row.waste.wasted.toFixed(0)} on ${row.clicks} clicks with no orders`,
        asin: entityAsin, brand: row.brand || null, entityLabel: label,
        evidence: [
          { label: "Spend", value: row.spend.toFixed(2) },
          { label: "Clicks", value: Math.round(row.clicks) },
          { label: "Orders", value: 0 },
          { label: "Impressions", value: Math.round(row.impressions) },
          { label: "CTR", value: row.ctr === null ? null : `${row.ctr.toFixed(2)}%` },
          { label: "CPC", value: row.cpc === null ? null : row.cpc.toFixed(2) },
          { label: "Campaign", value: row.campaignName || null },
          { label: "Ad product", value: (row.campaignTypes || []).join(", ") || null },
          { label: "Active days", value: row.activeDays || null },
        ],
        moneyAtRisk: row.waste.wasted,
        moneyBasis: `all spend on this row over ${data.window?.days} days, because it produced no attributed orders`,
        currency,
        confidence: "high",
        freshness,
        why: `${row.waste.note}, which is above the ${data.minClicksForWaste}-click minimum this report requires before calling spend wasted.`,
        action: level === "searchTerms"
          ? "Review this customer search term and consider adding it as a negative keyword in the campaign shown. This report is read-only and applies nothing itself."
          : "Pause or reduce the bid on this target, or fix the landing offer if the clicks should be converting. This report is read-only and changes nothing itself.",
      }));
      continue;
    }

    if (row.waste.kind === "breach") {
      const share = totalSpend > 0 ? row.waste.wasted / totalSpend : 0;
      insights.push(makeInsight({
        id: `ppc-breach-${level}-${row.key}`,
        reportKey: "ppc-performance",
        reportLabel: PPC_LABEL,
        category: "ppc-break-even-breach",
        severity: severityFromExposure({ share, moneyAtRisk: row.waste.wasted }),
        title: `"${label}" is ${row.acos.toFixed(0)}% ACoS, ${row.waste.wasted.toFixed(0)} above break-even`,
        asin: entityAsin, brand: row.brand || null, entityLabel: label,
        evidence: [
          { label: "Spend", value: row.spend.toFixed(2) },
          { label: "Attributed sales", value: row.sales.toFixed(2) },
          { label: "ACoS", value: `${row.acos.toFixed(1)}%` },
          { label: "Break-even target", value: `${breakEvenAcos}%` },
          { label: "Orders", value: Math.round(row.orders) },
          { label: "CVR", value: row.cvr === null ? null : `${row.cvr.toFixed(1)}%` },
          { label: "CPC", value: row.cpc === null ? null : row.cpc.toFixed(2) },
          { label: "Ad product", value: (row.campaignTypes || []).join(", ") || null },
        ],
        moneyAtRisk: row.waste.wasted,
        moneyBasis: `only the spend above the ${breakEvenAcos}% break-even target, not the whole spend, because the sales up to that point are still worth buying`,
        currency,
        confidence: "high",
        freshness,
        why: `This row converts but ${row.waste.note}, so the spend above break-even is buying unprofitable sales.`,
        action: "Lower the bid until ACoS reaches the break-even target, or improve conversion on the offer before spending more. Read-only: no bid is changed here.",
      }));
      continue;
    }

    if (row.waste.kind === "scale" && row.sales > 0) {
      insights.push(makeInsight({
        id: `ppc-scale-${level}-${row.key}`,
        reportKey: "ppc-performance",
        reportLabel: PPC_LABEL,
        kind: "opportunity",
        category: "ppc-scaling",
        severity: row.sales >= totalSpend * 0.1 ? "medium" : "low",
        title: `"${label}" returns ${row.roas === null ? "" : `${row.roas.toFixed(1)}x`} at ${row.acos.toFixed(0)}% ACoS`,
        asin: entityAsin, brand: row.brand || null, entityLabel: label,
        evidence: [
          { label: "Spend", value: row.spend.toFixed(2) },
          { label: "Attributed sales", value: row.sales.toFixed(2) },
          { label: "ACoS", value: `${row.acos.toFixed(1)}%` },
          { label: "Break-even target", value: `${breakEvenAcos}%` },
          { label: "Orders", value: Math.round(row.orders) },
          { label: "CVR", value: row.cvr === null ? null : `${row.cvr.toFixed(1)}%` },
        ],
        moneyAtRisk: row.sales,
        moneyBasis: "attributed sales this row already produces, which is the upside a budget or bid increase would build on",
        currency,
        confidence: "high",
        freshness,
        why: `${row.waste.note} with ${Math.round(row.orders)} attributed orders, so there is profitable headroom.`,
        action: "Consider raising the bid or budget here, after confirming stock cover so extra traffic does not hit an out-of-stock offer. Read-only: nothing is changed here.",
      }));
    }
  }
  return sortInsights(insights);
}

/* ==================================================================== */
/* Returns & Refund Leakage                                              */
/* ==================================================================== */

const RETURNS_LABEL = "Returns & Refund Leakage";

// Deterministic thresholds for the returns signal set, kept in one place so a reader can see exactly what the report
// means by "unusually high" / "excessive" / "aged". None of these invent a cause; each fires only on measured columns.
const HIGH_RETURN_RATE_PCT = 20;      // a product returned at/above this rate on real volume is a product problem
const HIGH_RATE_MIN_ORDERED = 25;     // ...but only once enough units were ordered for the rate to be trustworthy
const FBA_FEE_MIN = 50;               // absolute floor so a pennies fee never produces an alert
const FBA_FEE_SHARE = 0.3;            // return fees this large a share of the refund are unusually heavy
const AGED_RETURN_MIN = 5;            // this many return records with no settlement money at all -> flag for reconcile
const SELLER_LABEL_COST_MIN = 100;    // seller-paid FBM return-label cost worth surfacing at the account level

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

      const orderedUnits = Number(row.orderedUnits) || 0;
      // returnedUnits is the Returns-record count for the ASIN, or WITHHELD (null) when the ASIN spans
      // multiple currencies (a currency-ambiguous count cannot be divided by a per-currency denominator)
      // or has no Returns records at all. A withheld count => the rate is unavailable, never a false 0%.
      const rateWithheld = row.returnedUnits === null || row.returnedUnits === undefined;
      const returnedUnits = Number(row.returnedUnits) || 0;
      // A window that catches returns of earlier orders can report more returned
      // units than ordered units. That is a lag artefact, not a >100% rate, so
      // the rate is withheld and the row is ranked by money instead.
      const lagInflated = orderedUnits > 0 && returnedUnits > orderedUnits;
      const returnRate = (!rateWithheld && orderedUnits > 0 && !lagInflated) ? (returnedUnits / orderedUnits) * 100 : null;

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

// Blocker 2: the portfolio return rate is a PROVEN rate. A row is ELIGIBLE for the rate ONLY when its
// returnedUnits is KNOWN (not null/undefined) AND orderedUnits > 0 AND it is NOT lag-inflated
// (returnedUnits <= orderedUnits). Numerator (returnedUnits) AND denominator (orderedUnits) sum ONLY over
// eligible rows; an ineligible row contributes to NEITHER. ratePartial is set true whenever excluded
// evidence could move the rate:
//   (i)   currency-ambiguous withheld row -- returnedUnits null while orderedUnits > 0;
//   (ii)  returns with no usable denominator -- returnedUnits known but orderedUnits <= 0 / null;
//   (iii) lag-inflated -- returnedUnits > orderedUnits (a late return whose order is outside the window;
//         summing it would push the rate above 100%).
// rate is null when no proven ordered units exist. The UI then reads ratePartial to decide whether a null
// rate is an explicit "unavailable, partial" state or a plain "—".
export function returnsPortfolioRate(rows) {
  let provenReturned = 0;
  let provenOrdered = 0;
  let ratePartial = false;
  for (const row of Array.isArray(rows) ? rows : []) {
    const orderedUnits = Number(row.orderedUnits);
    if (row.returnedUnits === null || row.returnedUnits === undefined) {
      if (orderedUnits > 0) ratePartial = true; // (i) withheld returns over real ordered units
      continue;
    }
    const returnedUnits = Number(row.returnedUnits);
    if (!(orderedUnits > 0)) { ratePartial = true; continue; }     // (ii) no usable denominator
    if (returnedUnits > orderedUnits) { ratePartial = true; continue; } // (iii) lag-inflated
    provenReturned += returnedUnits;
    provenOrdered += orderedUnits;
  }
  return {
    rate: provenOrdered > 0 ? (provenReturned / provenOrdered) * 100 : null,
    ratePartial,
  };
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
    if (row.returnRate !== null && row.returnRate >= 15 && (row.orderedUnits || 0) >= 20 && severity === "low") {
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
        { label: "Units ordered in window", value: row.orderedUnits === null ? null : Math.round(row.orderedUnits) },
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

    // Unusually high return rate on real volume. The rate is recomputed from summed units (never averaged) and is
    // only trusted once enough units were ordered, so a tiny product's scary-looking rate does not raise an alert.
    if (row.returnRate !== null && row.returnRate >= HIGH_RETURN_RATE_PCT && (row.orderedUnits || 0) >= HIGH_RATE_MIN_ORDERED) {
      insights.push(makeInsight({
        id: `returns-rate-${row.currency || "na"}-${row.asin}`,
        reportKey: "returns-leakage",
        reportLabel: RETURNS_LABEL,
        category: "returns-high-rate",
        severity: row.returnRate >= HIGH_RETURN_RATE_PCT * 1.5 ? "high" : "medium",
        title: `${label} is returned ${row.returnRate.toFixed(1)}% of the time on ${Math.round(row.orderedUnits)} ordered units`,
        asin: row.asin, sku: row.sku, brand: row.brand, entityLabel: label,
        evidence: [
          { label: "Return rate", value: `${row.returnRate.toFixed(1)}%` },
          { label: "Returned items", value: row.returnCount || 0 },
          { label: "Units ordered in window", value: Math.round(row.orderedUnits) },
          { label: "Top reason", value: row.topReasons?.[0] ? `${row.topReasons[0].reason} (${row.topReasons[0].count})` : null },
          { label: "Fixable share of returns", value: row.actionableShare === null ? null : `${row.actionableShare.toFixed(0)}%` },
        ],
        moneyAtRisk: row.hasMoney ? row.totalLeakage : null,
        moneyBasis: row.hasMoney ? `settled refunds plus seller-borne return fees on this product over ${data.window?.days} days` : null,
        currency: row.currency,
        confidence: "high",
        freshness,
        why: `This product's return rate is at or above ${HIGH_RETURN_RATE_PCT}% on a meaningful order volume: ${row.returnCount} returned items over ${Math.round(row.orderedUnits)} ordered units in the window.`,
        action: meta && meta.actionable
          ? meta.action
          : "Pull this product's return reasons in Seller Central; a high rate on real volume usually has one fixable cause even when the mix looks split.",
      }));
    }

    // Excessive seller-borne FBA return fees relative to the refund itself: the fulfilment cost of each return is
    // heavy against what the customer got back, which is a packaging / returnless-refund signal, not a product one.
    if ((row.fbaReturns || 0) > 0 && (row.returnFees || 0) >= FBA_FEE_MIN && (row.returnFees || 0) >= (Number(row.refundedAmount) || 0) * FBA_FEE_SHARE) {
      insights.push(makeInsight({
        id: `returns-fees-${row.currency || "na"}-${row.asin}`,
        reportKey: "returns-leakage",
        reportLabel: RETURNS_LABEL,
        category: "returns-fba-fees",
        severity: severityFromExposure({ share: totalLeakage > 0 ? row.returnFees / totalLeakage : 0, moneyAtRisk: row.returnFees }),
        title: `${label} paid ${Number(row.returnFees).toFixed(0)} in return fees against ${Number(row.refundedAmount || 0).toFixed(0)} of refunds`,
        asin: row.asin, sku: row.sku, brand: row.brand, entityLabel: label,
        evidence: [
          { label: "Seller-borne return fees", value: Number(row.returnFees).toFixed(2) },
          { label: "Customer refunds", value: Number(row.refundedAmount || 0).toFixed(2) },
          { label: "FBA returns", value: row.fbaReturns || 0 },
          { label: "Returned items", value: row.returnCount || 0 },
        ],
        moneyAtRisk: row.returnFees,
        moneyBasis: "seller-borne return commission plus the FBA customer-return per-unit fee, less restocking recovered, over the window",
        currency: row.currency,
        confidence: "high",
        freshness,
        why: `Return fees are ${((row.returnFees / Math.max(1, Number(row.refundedAmount) || 0)) * 100).toFixed(0)}% of the refund value on this FBA product, so the cost of processing each return is unusually high relative to what was refunded.`,
        action: "Check the FBA per-unit return fee and returns processing for this ASIN; a high fee-to-refund ratio often points to oversized or overweight packaging, or to returnless-refund handling.",
      }));
    }

    // Aged unmatched returns: return records exist but no REFUND settlement has posted against them in the window.
    if ((row.returnCount || 0) >= AGED_RETURN_MIN && (row.refundEvents || 0) === 0 && (Number(row.refundedAmount) || 0) === 0) {
      insights.push(makeInsight({
        id: `returns-aged-${row.currency || "na"}-${row.asin}`,
        reportKey: "returns-leakage",
        reportLabel: RETURNS_LABEL,
        category: "returns-aged-unmatched",
        severity: "low",
        title: `${label} has ${row.returnCount} returned items with no matching refund settlement yet`,
        asin: row.asin, sku: row.sku, brand: row.brand, entityLabel: label,
        evidence: [
          { label: "Returned items", value: row.returnCount || 0 },
          { label: "Pending return requests", value: row.pendingReturnRequests || 0 },
          { label: "Refund settlement events", value: 0 },
          { label: "Top reason", value: row.topReasons?.[0] ? `${row.topReasons[0].reason} (${row.topReasons[0].count})` : null },
        ],
        moneyAtRisk: null,
        moneyBasis: null,
        currency: row.currency,
        confidence: "medium",
        freshness,
        why: "The Returns source shows return records for this product but no REFUND settlement event has posted against them in the window, so either the refunds are still settling or these returns predate this report's settlement coverage.",
        action: "Reconcile these returns in Seller Central: confirm whether the refunds are still processing or the returns are older than the settlement window before treating them as resolved.",
      }));
    }
  }

  // Account-level: a high seller-paid FBM return-label cost, an FBM-only figure the Returns source reports directly.
  // It is separate from the settlement leakage above (which covers both channels), so it is surfaced on its own.
  const labelCost = Number(data.fbmOnly?.sellerBorneLabelCost) || 0;
  if (labelCost >= SELLER_LABEL_COST_MIN) {
    const labelCurrency = (data.currencies || []).length === 1 ? data.currencies[0] : null;
    insights.push(makeInsight({
      id: "returns-seller-label-cost",
      reportKey: "returns-leakage",
      reportLabel: RETURNS_LABEL,
      category: "returns-label-cost",
      severity: "medium",
      title: `${labelCost.toFixed(0)} of FBM return labels were billed to the seller in this window`,
      entityLabel: "Account pattern",
      evidence: [
        { label: "Seller-borne return-label cost (FBM)", value: labelCost.toFixed(2) },
        { label: "FBM refunded amount", value: Number(data.fbmOnly?.refundedAmount || 0).toFixed(2) },
        { label: "Pending return requests", value: data.pendingReturnRequests || 0 },
      ],
      moneyAtRisk: labelCurrency ? labelCost : null,
      moneyBasis: labelCurrency ? "return-shipping labels the Returns source reports as billed to the seller for FBM returns in the window" : null,
      currency: labelCurrency,
      confidence: "high",
      freshness,
      why: "The Returns source reports return-shipping labels billed to the seller for FBM returns. A high seller-paid label total is a return-policy and packaging cost separate from the settlement leakage above.",
      action: "Review the FBM return-shipping policy and label cost for the most-returned SKUs; consider right-sizing packaging and revisiting who pays return postage.",
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
  const stockState = insightInventoryState(data);
  const fallback = stockState.source === "health-fallback";
  const freshness = freshnessNote({
    sourceLabel: data.sourceLabel,
    asOf: data.observedWindow?.to || data.asOf,
    extra: stockState.available ? `stock and fulfilment channel: ${stockState.label}; competitive prices not evaluated` : "FBA stock unavailable; competitive prices not evaluated",
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
        { label: `FBA available (${stockState.sourceShort || "unavailable"})`, value: row.fbaAvailable === null || row.fbaAvailable === undefined ? null : Math.round(row.fbaAvailable) },
        { label: `Fulfillment channel (${fallback ? "Listings identity" : "Listings"})`, value: row.fulfillmentChannel || null },
        // No competitive prices / run rate: they were FBA Inventory Health metrics, which is no longer requested.
      ],
      moneyAtRisk: row.salesAtRisk,
      moneyBasis: `sales x (1 − Buy Box share) over the last ${row.windowDays} days for this SKU`,
      currency: row.currency,
      // A cause resting on a saved-bridge figure, or on a Listings snapshot older than this report, is qualified.
      confidence: row.cause === "unconfirmed" ? "low" : (fallback || (row.cause === "stock" && stockState.stale) ? "medium" : "high"),
      freshness,
      why: `Buy Box share is below the ${thresholdPct}% threshold on a SKU that is still selling. ${row.causeDetail}`,
      action: BUY_BOX_ACTIONS[row.cause],
    }));
  }
  return sortInsights(insights);
}
