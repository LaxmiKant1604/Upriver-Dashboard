/* =====================================================================
   report-status -- the header's STATUS-ONLY data-source label
   =====================================================================

   Tells the viewer HOW the report on screen gets its data. It is status only: it publishes nothing, refreshes
   nothing and never calls DataDoe. The header's Reload button stays a read-only re-read of the saved copy.

   REPORT_DATA_STATUS is a browser-safe MIRROR of REPORT_MATERIALIZATION[action].dataStatus
   (lib/server/reports/report-materialization-registry.js), which the browser cannot import (its closure pulls in
   node:crypto). scripts/report-status.test.js pins this mirror EQUAL to the server registry, and every NAV_GROUPS
   view id (src/components/shell.jsx) to exactly one entry below, so a newly registered report or view cannot ship
   without an honest status. Pure and framework-free. */

// Mirror of REPORT_MATERIALIZATION[action].savedDataPublish -- ONLY the reports whose single-scope zero-export
// "Publish from saved data" executor is implemented and tested (pinned EQUAL to the registry by test). The shared
// control (src/components/SavedDataPublishControl.jsx) renders for these and nothing else.
export const SAVED_DATA_PUBLISH = Object.freeze({
  "brand-view": "brand-view",
});
/** The recovery route a report publishes through from saved data, or null (no control for this report). */
export function savedDataPublishRoute(action) {
  return Object.prototype.hasOwnProperty.call(SAVED_DATA_PUBLISH, action) ? SAVED_DATA_PUBLISH[action] : null;
}

// Mirror of REPORT_MATERIALIZATION[action].dataStatus -- keyed by the registry's ACTION keys (pinned by test).
export const REPORT_DATA_STATUS = Object.freeze({
  "brand-sales": "scheduled",
  "daily": "scheduled",
  "brand-inventory": "scheduled",
  "fba-plan": "scheduled",
  "sku-movement": "scheduled",
  "returns-leakage": "scheduled",
  "brand-view": "scheduled",
  "brand-view-portfolio": "scheduled",
  "brand-portfolio": "dormant",
  "brand-view-brands": "scheduled",
  "brand-directory": "read-time",
  "oli-quality": "read-time",
  "oli-quality-summary": "read-time",
  "listing-health-v3": "scheduled",
  "sales": "dormant",
  "reconciliation": "paid-manual",
  "sku-pl": "paid-manual",
  "keyword-rank": "paid-manual",
  "content-changes": "paid-manual",
  "sales-movers": "paid-manual",
  "listing-health": "paid-manual",
  "buy-box-loss": "paid-manual",
  "ppc-performance": "paid-manual",
  "listing-optimizer": "paid-manual",
});

// What the viewer sees. Wording rule: describe the data source; never offer to update or publish.
export const DATA_STATUS_COPY = Object.freeze({
  "scheduled": Object.freeze({
    label: "Daily schedule",
    detail: "The scheduler publishes this report. You are seeing the latest copy it published. Reload re-reads that copy; it does not publish or call DataDoe.",
  }),
  "read-time": Object.freeze({
    label: "Built on open",
    detail: "Rebuilt from data already saved each time this page loads. Reload re-reads it; it does not publish or call DataDoe.",
  }),
  "paid-manual": Object.freeze({
    label: "Paid report",
    detail: "Only an admin paid sync refreshes this report, and that uses DataDoe tokens. You are seeing the saved copy. Reload re-reads it.",
  }),
});

// Every NAV_GROUPS view id (plus brand mode of the dashboard) -> the report action it shows, or a view-level status
// for pages that have no stored report of their own. `name` is the report name used in the explanation.
export const VIEW_REPORT_STATUS = Object.freeze({
  "dashboard": Object.freeze({ action: "brand-sales", name: "Sales Dashboard" }),
  // In brand mode the header Reload re-reads the saved BRAND LIST only, so the explanation says exactly that.
  "dashboard#brand": Object.freeze({ action: "brand-view-portfolio", name: "Brand View portfolio", detail: "The scheduler publishes this report; you are seeing its latest published copy. The header Reload re-reads the saved brand list only; \"Reload saved data\" inside the page re-reads the portfolio (or builds it from saved data when none has been published for these accounts yet). Neither publishes or calls DataDoe." }),
  "priority": Object.freeze({ none: "Combines six saved reports; each report page shows its own status." }),
  "daily": Object.freeze({ action: "daily", name: "Daily Reporting" }),
  "returns": Object.freeze({ action: "returns-leakage", name: "Returns & Refund Leakage" }),
  "fbaplan": Object.freeze({ action: "fba-plan", name: "FBA Shipment Plan" }),
  "listinghealth-v3": Object.freeze({ action: "listing-health-v3", name: "Listing Health" }),
  "listinghealth": Object.freeze({ action: "listing-health-v3", name: "Listing Health" }), // legacy id resolves to v3
  "skumovement": Object.freeze({ action: "sku-movement", name: "SKU Movement" }),
  "campaign-ads": Object.freeze({ status: "read-time", name: "Ad Performance by Campaign", detail: "Built from the saved campaign rows each time this page loads. Reload re-reads them; it does not publish or call DataDoe." }),
  "ppc": Object.freeze({ action: "ppc-performance", name: "PPC Performance" }), // shown only when the Campaign Ads tab is off
  "reconciliation": Object.freeze({ action: "reconciliation", name: "Reconciliation" }),
  "skupl": Object.freeze({ action: "sku-pl", name: "SKU P&L" }),
  "keywordrank": Object.freeze({ action: "keyword-rank", name: "Keyword Rank" }),
  "contentchanges": Object.freeze({ action: "content-changes", name: "Content Alerts" }),
  "salesmovers": Object.freeze({ action: "sales-movers", name: "Sales Movers" }),
  "buybox": Object.freeze({ action: "buy-box-loss", name: "Buy Box Loss" }),
  "optimizer": Object.freeze({ action: "listing-optimizer", name: "Listing Optimizer" }),
  "brandview": Object.freeze({ action: "brand-view", name: "Brand View" }),
  "sync-center": Object.freeze({ none: "Admin tool, not a report." }),
  "access": Object.freeze({ none: "Admin tool, not a report." }),
});

// When the SERVED response says it was rebuilt from saved data at read time (a Listing Health preview, a read-only
// re-derive), that copy is described as such, whatever the report's usual owner.
export const BUILT_ON_READ_DETAIL = "This copy was rebuilt from data already saved when the page loaded; the scheduler did not publish it. Nothing here publishes or calls DataDoe.";

// When NO copy is on screen (still loading, an error, a waiting state, no account), the status describes only where
// the data comes from -- it never claims a copy is shown.
export const NO_COPY_DETAIL = Object.freeze({
  "scheduled": "The scheduler publishes this report. No saved copy is on screen yet. Nothing here publishes or calls DataDoe.",
  "read-time": "Built from data already saved each time this page loads. Nothing is on screen yet. Nothing here publishes or calls DataDoe.",
  "paid-manual": "Only an admin paid sync refreshes this report, and that uses DataDoe tokens. No saved copy is on screen yet.",
});

/** True when a served body says it was built at read time (preview:true, or snapshot.rederived:true). */
export function servedBuiltOnRead(served) {
  return Boolean(served && typeof served === "object" && (served.preview === true || (served.snapshot && served.snapshot.rederived === true)));
}

/**
 * The header status of the view on screen: { status, label, detail } or null (no report of its own).
 * `campaignAdsTab` mirrors the CAMPAIGN_ADS_TAB flag: with it on, the "ppc" view renders the Campaign Ads workspace.
 * `served` (optional) is the served body of the report on screen, when the page keeps it. `hasCopy` is false when no
 * copy is on screen (loading, error, waiting, no account): the explanation then never claims one is shown.
 */
export function viewDataStatus(view, { dashboardMode = "account", campaignAdsTab = true, served = null, hasCopy = true } = {}) {
  const id = view === "dashboard" && dashboardMode === "brand" ? "dashboard#brand"
    : view === "ppc" && campaignAdsTab ? "campaign-ads"
    : view;
  const entry = VIEW_REPORT_STATUS[id];
  if (!entry || entry.none) return null;
  const registryStatus = entry.status || REPORT_DATA_STATUS[entry.action];
  if (!DATA_STATUS_COPY[registryStatus]) return null; // dormant / unknown: never invent a status
  const status = servedBuiltOnRead(served) ? "read-time" : registryStatus;
  const label = DATA_STATUS_COPY[status].label;
  if (hasCopy === false) return { status, label, detail: `${entry.name}: ${NO_COPY_DETAIL[status]}` };
  if (status !== registryStatus) return { status, label, detail: `${entry.name}: ${BUILT_ON_READ_DETAIL}` };
  return { status, label, detail: `${entry.name}: ${entry.detail || DATA_STATUS_COPY[status].detail}` };
}

/** The header's "Loaded" time: time only for today, otherwise the date too (a copy from yesterday never reads as today). */
export function formatLoadedStamp(date, now = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return sameDay ? date.toLocaleTimeString() : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${date.toLocaleTimeString()}`;
}
