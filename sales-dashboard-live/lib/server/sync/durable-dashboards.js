// Scheduler v2 -- DAILY REPORTING + BRAND VIEW over the DURABLE SOURCE MODEL (pure, ZERO I/O).
//
// The first high-priority dashboard tranche reads the durable evidence instead of raw per-cycle exports:
//   - Daily Reporting: durable OLI history (account/date/SKU/ASIN/currency) + the durable catalog brand map
//     + the CAMPAIGN-grain Ads architecture (ad_daily_metrics; coverage proven from successful windows);
//   - Brand View: the SAME OLI history + the SAME catalog brand map + the ASIN-grain Ads architecture
//     (asin-performance-v1) + the latest validated FBA snapshot joined through the SAME brand map.
// The two dashboards therefore REUSE one OLI/catalog evidence set (proven by test), and the overlapping Ads
// grains are NEVER summed together: each readiness/fold accepts EXACTLY its own grain and fails closed on
// the other (typed), so a mixed input can never silently double-count.
//
// Brand attribution uses the canonical brand-resolution policy (ASIN wins; unique-SKU fallback; ambiguous/
// blank stays UNMAPPED -- never a fabricated "Unassigned" catalog brand). Unmapped sales are reported under
// `unmapped`, distinctly from any real brand.

import { resolveBrand } from "./brand-resolution.js";
import { windowsProve } from "./source-durable-model.js";
import { REPORT_DERIVATIONS, shadowSnapshotKey } from "./report-derivation.js";
import { buildDailyAdsCoverage } from "./daily-ads-loader.js";
import { canonicalOliSlices } from "../date-windows.js";

export const DAILY_ADS_GRAIN = "campaign-performance-v1";
export const BRAND_VIEW_ADS_GRAIN = "asin-performance-v1";

const isDateStr = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

function requireWindow(from, to, label) {
  if (!isDateStr(from) || !isDateStr(to) || from > to) {
    throw new Error(`${label} requires a valid from <= to window (fail closed).`);
  }
}

function requireHistoryRow(r) {
  if (!r || typeof r !== "object") throw new Error("durable-dashboards: malformed history row (fail closed).");
  const date = r.sale_date ?? r.saleDate;
  const currency = r.currency;
  const account = r.account_id ?? r.accountId;
  if (!isDateStr(String(date || "")) || !/^[A-Z]{3}$/.test(String(currency || "")) || !String(account || "").trim()) {
    throw new Error("durable-dashboards: a history row is missing its canonical grain (fail closed).");
  }
  return {
    accountId: String(account),
    date: String(date),
    sku: String(r.sku ?? ""),
    childAsin: String(r.child_asin ?? r.childAsin ?? ""),
    currency: String(currency),
    sales: Number(r.sales_amount ?? r.salesAmount ?? 0),
    units: Number(r.units ?? 0),
  };
}

/**
 * Fold durable OLI history into DAILY rows for one brand (or every brand when brand === "ALL").
 * Brand attribution: resolveBrand (ASIN wins; unique-SKU fallback; else unmapped). A named-brand fold keeps
 * ONLY rows resolving to that brand; the ALL fold keeps everything and reports how much stayed unmapped
 * (never silently attributed). Fold key: date|currency -- money is NEVER summed across currencies.
 * Returns { rows: [{date, currency, sales, units}], unmapped: {sales, units}, brandFiltered }.
 */
export function dailyRowsFromHistory({ historyRows, brandMaps, brand = "ALL", from, to } = {}) {
  requireWindow(from, to, "dailyRowsFromHistory");
  if (!Array.isArray(historyRows)) throw new Error("dailyRowsFromHistory requires an array of history rows (fail closed).");
  const named = brand !== "ALL";
  const byKey = new Map();
  const unmapped = { sales: 0, units: 0 };
  for (const raw of historyRows) {
    const r = requireHistoryRow(raw);
    if (r.date < from || r.date > to) continue;
    const resolved = resolveBrand({ childAsin: r.childAsin, sku: r.sku }, brandMaps);
    if (named) {
      if (resolved.brand !== brand) continue; // strict named-brand filter (an unmapped row never leaks in)
    } else if (resolved.brand == null) {
      unmapped.sales += r.sales;
      unmapped.units += r.units;
    }
    const key = r.date + "|" + r.currency;
    const cur = byKey.get(key) || { date: r.date, currency: r.currency, sales: 0, units: 0 };
    cur.sales += r.sales;
    cur.units += r.units;
    byKey.set(key, cur);
  }
  const rows = [...byKey.values()].sort((a, b) => (a.date === b.date ? (a.currency < b.currency ? -1 : 1) : (a.date < b.date ? -1 : 1)));
  return { rows, unmapped, brandFiltered: named };
}

/**
 * Fold durable OLI history into BRAND VIEW aggregates: brand x account x currency over the window, via the
 * SAME brand maps (the reuse the mission requires). Unmapped rows aggregate under `unmapped` per
 * account/currency -- reported, never invented as a brand.
 * Returns { brands: [{brand, accountId, currency, sales, units}], unmapped: [{accountId, currency, sales, units}] }.
 */
export function brandViewRowsFromHistory({ historyRows, brandMaps, from, to } = {}) {
  requireWindow(from, to, "brandViewRowsFromHistory");
  if (!Array.isArray(historyRows)) throw new Error("brandViewRowsFromHistory requires an array of history rows (fail closed).");
  const byBrand = new Map();
  const byUnmapped = new Map();
  for (const raw of historyRows) {
    const r = requireHistoryRow(raw);
    if (r.date < from || r.date > to) continue;
    const resolved = resolveBrand({ childAsin: r.childAsin, sku: r.sku }, brandMaps);
    if (resolved.brand == null) {
      const key = r.accountId + "|" + r.currency;
      const cur = byUnmapped.get(key) || { accountId: r.accountId, currency: r.currency, sales: 0, units: 0 };
      cur.sales += r.sales; cur.units += r.units;
      byUnmapped.set(key, cur);
      continue;
    }
    const key = resolved.brand + "|" + r.accountId + "|" + r.currency;
    const cur = byBrand.get(key) || { brand: resolved.brand, accountId: r.accountId, currency: r.currency, sales: 0, units: 0 };
    cur.sales += r.sales; cur.units += r.units;
    byBrand.set(key, cur);
  }
  const sortKey = (x) => [x.brand || "", x.accountId, x.currency].join("|");
  return {
    brands: [...byBrand.values()].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1)),
    unmapped: [...byUnmapped.values()].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1)),
  };
}

/* ------------------------------ Ads grain guards + coverage proofs ------------------------------ */

function requireGrain(adsEvidence, expectedGrain, label) {
  if (!adsEvidence || typeof adsEvidence !== "object") {
    return { proven: false, reason: "ads-evidence-missing" };
  }
  if (adsEvidence.grain !== expectedGrain) {
    // The OVERLAPPING Ads grains must never be summed/mixed: the wrong grain is a typed hard failure, not a
    // degraded pass -- a caller can never feed ASIN rows into Daily or campaign rows into Brand View.
    throw new Error(`${label}: ads evidence carries grain "${adsEvidence.grain}" but requires "${expectedGrain}" (never mix overlapping Ads grains; fail closed).`);
  }
  return null;
}

// Durable Ads coverage proof for a dashboard window. AUTHORITATIVE per-account evidence (finding 8): when
// `windowsByAccountId` is present, EVERY listed account's own successful windows must span [from, to] --
// a per-account gap is reported with its accountId. The org-level `windows` shape stays supported for
// callers with genuinely account-free evidence. Never proven on a non-ok read or malformed window.
function adsCoverageProof(adsEvidence, from, to, accounts = null) {
  if (adsEvidence.read !== "ok") return { proven: false, gaps: [{ accountId: null, reason: "ads-coverage-read-not-ok" }] };
  if (adsEvidence.windowsByAccountId && typeof adsEvidence.windowsByAccountId === "object") {
    const list = Array.isArray(accounts) && accounts.length ? accounts : Object.keys(adsEvidence.windowsByAccountId);
    if (!list.length) return { proven: false, gaps: [{ accountId: null, reason: "ads-coverage-no-accounts" }] };
    const gaps = [];
    for (const accountId of list) {
      const windows = adsEvidence.windowsByAccountId[accountId];
      if (!Array.isArray(windows)) { gaps.push({ accountId, reason: "ads-coverage-windows-not-array" }); continue; }
      try {
        if (!windowsProve(windows, from, to)) gaps.push({ accountId, reason: "ads-coverage-incomplete" });
      } catch (_e) {
        gaps.push({ accountId, reason: "ads-coverage-window-malformed" });
      }
    }
    return { proven: gaps.length === 0, gaps };
  }
  if (!Array.isArray(adsEvidence.windows)) return { proven: false, gaps: [{ accountId: null, reason: "ads-coverage-windows-not-array" }] };
  try {
    return windowsProve(adsEvidence.windows, from, to)
      ? { proven: true, gaps: [] }
      : { proven: false, gaps: [{ accountId: null, reason: "ads-coverage-incomplete" }] };
  } catch (_e) {
    return { proven: false, gaps: [{ accountId: null, reason: "ads-coverage-window-malformed" }] };
  }
}

/**
 * READINESS of Daily Reporting over the durable model for [from, to]:
 *   - order-line-items: every account's durable coverage proves the window;
 *   - product-catalog : a validated durable catalog snapshot exists;
 *   - ads (CAMPAIGN grain ONLY): durable coverage proves the window (ads never block sales -- their gap is
 *     reported as a blocking source for the ADS half, with blocksSales:false).
 * Returns { ready, blockedBy: [{sourceKey, reason, accountId?, blocksSales}] }.
 */
export function dailyReportingReadiness({ oliCoverageByAccountId = {}, accounts = [], catalogSnapshot = null, campaignAds = null, from, to } = {}) {
  requireWindow(from, to, "dailyReportingReadiness");
  const blockedBy = [];
  if (!Array.isArray(accounts) || accounts.length === 0) {
    blockedBy.push({ sourceKey: "order-line-items", reason: "no-accounts", blocksSales: true });
  }
  for (const accountId of accounts) {
    let proven = false;
    try { proven = windowsProve(oliCoverageByAccountId[accountId] || [], from, to); } catch (_e) { proven = false; }
    if (!proven) blockedBy.push({ sourceKey: "order-line-items", reason: "coverage-incomplete", accountId, blocksSales: true });
  }
  if (!catalogSnapshot || !catalogSnapshot.validated_at) {
    blockedBy.push({ sourceKey: "product-catalog", reason: "no-validated-snapshot", blocksSales: true });
  }
  const grainError = requireGrain(campaignAds, DAILY_ADS_GRAIN, "dailyReportingReadiness");
  if (grainError) {
    blockedBy.push({ sourceKey: "ads-campaign-date", reason: grainError.reason, blocksSales: false });
  } else {
    const proof = adsCoverageProof(campaignAds, from, to, accounts);
    for (const gap of proof.gaps) blockedBy.push({ sourceKey: "ads-campaign-date", reason: gap.reason, accountId: gap.accountId ?? undefined, blocksSales: false });
  }
  return { ready: blockedBy.filter((b) => b.blocksSales).length === 0, adsReady: !blockedBy.some((b) => b.sourceKey === "ads-campaign-date"), blockedBy };
}

/**
 * READINESS of Brand View over the durable model for [from, to]:
 *   - order-line-items + product-catalog: as Daily (the SAME evidence set);
 *   - ads (ASIN grain ONLY): durable coverage proves the window (ad spend withheld otherwise, sales shown);
 *   - fba-inventory-health: a validated per-account snapshot (inventory enrichment; missing => inventory
 *     unavailable, never a fabricated zero).
 */
export function brandViewReadiness({ oliCoverageByAccountId = {}, accounts = [], catalogSnapshot = null, asinAds = null, fbaSnapshotsByAccount = {}, from, to } = {}) {
  requireWindow(from, to, "brandViewReadiness");
  const blockedBy = [];
  if (!Array.isArray(accounts) || accounts.length === 0) {
    blockedBy.push({ sourceKey: "order-line-items", reason: "no-accounts", blocksSales: true });
  }
  for (const accountId of accounts) {
    let proven = false;
    try { proven = windowsProve(oliCoverageByAccountId[accountId] || [], from, to); } catch (_e) { proven = false; }
    if (!proven) blockedBy.push({ sourceKey: "order-line-items", reason: "coverage-incomplete", accountId, blocksSales: true });
  }
  if (!catalogSnapshot || !catalogSnapshot.validated_at) {
    blockedBy.push({ sourceKey: "product-catalog", reason: "no-validated-snapshot", blocksSales: true });
  }
  const grainError = requireGrain(asinAds, BRAND_VIEW_ADS_GRAIN, "brandViewReadiness");
  if (grainError) {
    blockedBy.push({ sourceKey: "ads-asin-date", reason: grainError.reason, blocksSales: false });
  } else {
    const proof = adsCoverageProof(asinAds, from, to, accounts);
    for (const gap of proof.gaps) blockedBy.push({ sourceKey: "ads-asin-date", reason: gap.reason, accountId: gap.accountId ?? undefined, blocksSales: false });
  }
  for (const accountId of accounts) {
    const snap = fbaSnapshotsByAccount[accountId];
    if (!snap || !snap.validated_at) {
      blockedBy.push({ sourceKey: "fba-inventory-health", reason: "no-validated-snapshot", accountId, blocksSales: false });
    }
  }
  return { ready: blockedBy.filter((b) => b.blocksSales).length === 0, adsReady: !blockedBy.some((b) => b.sourceKey === "ads-asin-date"), blockedBy };
}

/* --------------- durable shadow snapshot derivation through the EXISTING contracts --------------- */
//
// Finding 3: NO orphan custom report keys. The durable outputs ARE the existing report contracts:
//   - Daily Reporting: the REAL REPORT_DERIVATIONS["daily-reporting"] adapter (snapshotVersion
//     "daily-reporting/v2d-3", the exact live-parity payload the API/frontend consume), fed with
//     canonical-fragment rows reconstructed from durable history + the REAL campaign Ads metric rows and
//     the REAL buildDailyAdsCoverage/resolveDailyAdsAvailability contract -- so the payload carries actual
//     campaign ad metrics with honest availability;
//   - Brand View: the REAL REPORT_DERIVATIONS["brand-sales"] adapter (snapshotVersion "brand-sales/v2d-2",
//     { rows, catalogBrands, asinBrand }) -- EXACTLY the saved payload the live Brand View assembles from
//     (aggregateBrandSales + asinBrand for FBA inventory attribution). ASIN Ads + FBA inventory reach Brand
//     View through their existing durable stores (asin-performance-v1 rows + the validated FBA snapshot),
//     proven by the consumption tests.
// Snapshots save ONLY under the existing scheduler-v2/* shadow keys with the existing versions and are
// validated by the existing validatePayload contracts. A derive failure (typed unavailable/invalid) skips
// that account typed -- nothing fabricated, LKG preserved.

// Durable history rows -> the canonical OLI fragment shape the existing derivations consume.
export function fragmentRowsFromHistory(historyRows, accountId) {
  return (historyRows || [])
    .filter((r) => String(r.account_id ?? r.accountId) === String(accountId))
    .map((r) => ({
      date: String(r.sale_date ?? r.saleDate),
      seller_or_vendor_id: String(r.seller_or_vendor_id ?? r.sellerOrVendorId ?? ""),
      sku: String(r.sku ?? ""),
      child_asin: String(r.child_asin ?? r.childAsin ?? ""),
      item_price_currency: String(r.currency ?? ""),
      total_sales_sum: Number(r.sales_amount ?? r.salesAmount ?? 0),
      total_units_sum: Number(r.units ?? 0),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Durable history rows -> the brand-sales order-lines shape (seller name + marketplace from the account
// directory record -- an account is one marketplace; unpriced units are not tracked durably => 0).
export function orderRowsFromHistory(historyRows, account) {
  if (!account || !String(account.name || "").trim() || !String(account.country || "").trim()) {
    throw new Error("orderRowsFromHistory requires the account's directory name + marketplace country (fail closed).");
  }
  return fragmentRowsFromHistory(historyRows, account.accountId).map((r) => ({
    date: r.date,
    seller_or_vendor_id: r.seller_or_vendor_id,
    seller_or_vendor_name: String(account.name),
    marketplace_country_code: String(account.country),
    item_price_currency: r.item_price_currency,
    child_asin: r.child_asin,
    total_sales_sum: r.total_sales_sum,
    total_units_sold_sum: r.total_units_sum,
    unpriced_units_sum: 0,
  }));
}

// The sliced single-account source structure the daily derive validates (exact ordered canonical slices,
// every fragment window-bound).
export function slicedOliSourceFromHistory({ historyRows, accountId, rawSellerId, from, to }) {
  const rows = fragmentRowsFromHistory(historyRows, accountId).filter((r) => r.date >= from && r.date <= to);
  const fragments = canonicalOliSlices(from, to).map((slice) => ({
    from: slice.from, to: slice.to,
    sellerOrVendorIds: [String(rawSellerId)],
    rows: rows.filter((r) => r.date >= slice.from && r.date <= slice.to),
  }));
  return { rows: fragments.flatMap((f) => f.rows), fragments };
}

/**
 * Derive + VALIDATE the durable dashboard snapshots THROUGH THE EXISTING REPORT CONTRACTS. Readiness is
 * computed FIRST from the authoritative per-account evidence; a non-ready dashboard derives nothing (typed
 * skip; LKG stays). Per-account derive failures are typed skips, never fabrications. Returns:
 *   { daily:     { readiness, snapshots: [{reportKey, accountId, version, payload}], skipped: [...] },
 *     brandView: { readiness, snapshots: [...brand-sales per account...],           skipped: [...] } }
 */
export function deriveDurableDashboardSnapshots({
  bucket, accounts = [], historyRows = [], catalogRows = null,
  oliCoverageByAccountId = {}, catalogSnapshot = null, fbaSnapshotsByAccount = {},
  campaignAds = null, asinAds = null,
  // Finding 1 (round 4): per-account campaign Ads METRIC evidence carries its TYPED read state --
  // { rows, metricsRead: "ok" | "limit-exceeded" | "read-failed" }. A failed/limited/malformed read must
  // never masquerade as a clean zero-ad result: metricsRead threads into buildDailyAdsCoverage, whose
  // availability resolver fails the Ads half typed (sales survive; no false zero Ads).
  adMetricsByAccountId = {}, campaignCoverageStateByAccountId = {},
  dailyWindow, brandViewWindow,
} = {}) {
  if (bucket !== "us" && bucket !== "non-us") throw new Error("deriveDurableDashboardSnapshots requires bucket 'us'|'non-us' (fail closed).");
  if (!Array.isArray(catalogRows)) throw new Error("deriveDurableDashboardSnapshots requires the hydrated catalog rows (fail closed).");
  const accountIds = accounts.map((a) => String(a.accountId));

  const dailyEntry = REPORT_DERIVATIONS["daily-reporting"];
  const brandSalesEntry = REPORT_DERIVATIONS["brand-sales"];

  const dailyReadiness = dailyReportingReadiness({
    accounts: accountIds, oliCoverageByAccountId, catalogSnapshot, campaignAds,
    from: dailyWindow.from, to: dailyWindow.to,
  });
  const daily = { readiness: dailyReadiness, snapshots: [], skipped: [] };
  if (dailyReadiness.ready) {
    for (const account of accounts) {
      try {
        const source = slicedOliSourceFromHistory({
          historyRows, accountId: account.accountId, rawSellerId: account.rawSellerId,
          from: dailyWindow.from, to: dailyWindow.to,
        });
        const adMetrics = adMetricsByAccountId[account.accountId] || { rows: [], metricsRead: "read-failed" };
        const metricsRead = adMetrics.metricsRead === "ok" && Array.isArray(adMetrics.rows) ? "ok" : (adMetrics.metricsRead === "limit-exceeded" ? "limit-exceeded" : "read-failed");
        const adsCoverage = buildDailyAdsCoverage({
          accountId: account.accountId, rawSellerId: account.rawSellerId, currency: account.currency ?? null,
          from: dailyWindow.from, to: dailyWindow.to,
          metricRows: metricsRead === "ok" ? adMetrics.rows : [],
          metricsRead,
          coverageState: campaignCoverageStateByAccountId[account.accountId] || { windows: [], status: "missing", latestMetricDate: null, read: "read-failed", error: "COVERAGE_READ_FAILED" },
        });
        const payload = dailyEntry.derive({
          sources: { "daily-reporting:oli-sales": source, "daily-reporting:catalog": { rows: catalogRows } },
          context: {
            from: dailyWindow.from, to: dailyWindow.to, brand: "ALL",
            accountId: account.accountId, rawSellerId: account.rawSellerId, currency: account.currency ?? null,
            adsCoverage,
          },
        });
        if (!dailyEntry.validatePayload(payload)) throw new Error("daily durable payload failed the EXISTING contract validator");
        daily.snapshots.push({ reportKey: shadowSnapshotKey("daily-reporting"), productionReportKey: "daily-reporting", accountId: account.accountId, version: dailyEntry.snapshotVersion, payload, latestDataDate: dailyEntry.latestDataDate(payload) });
      } catch (e) {
        daily.skipped.push({ accountId: account.accountId, reason: e && e.deriveStatus ? `derive-${e.deriveStatus}` : "derive-invalid" });
      }
    }
  }

  const brandViewReadinessResult = brandViewReadiness({
    accounts: accountIds, oliCoverageByAccountId, catalogSnapshot, asinAds, fbaSnapshotsByAccount,
    from: brandViewWindow.from, to: brandViewWindow.to,
  });
  const brandView = { readiness: brandViewReadinessResult, snapshots: [], skipped: [] };
  if (brandViewReadinessResult.ready) {
    for (const account of accounts) {
      try {
        const orderRows = orderRowsFromHistory(historyRows, account)
          .filter((r) => r.date >= brandViewWindow.from && r.date <= brandViewWindow.to);
        const payload = brandSalesEntry.derive({
          sources: { "brand-sales:order-lines": { rows: orderRows }, "brand-sales:catalog": { rows: catalogRows } },
        });
        if (!brandSalesEntry.validatePayload(payload)) throw new Error("brand-sales durable payload failed the EXISTING contract validator");
        brandView.snapshots.push({ reportKey: shadowSnapshotKey("brand-sales"), productionReportKey: "brand-sales", accountId: account.accountId, version: brandSalesEntry.snapshotVersion, payload, latestDataDate: brandSalesEntry.latestDataDate(payload) });
      } catch (e) {
        brandView.skipped.push({ accountId: account.accountId, reason: e && e.deriveStatus ? `derive-${e.deriveStatus}` : "derive-invalid" });
      }
    }
  }

  return { daily, brandView };
}
