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

// Durable Ads coverage proof for a dashboard window: the successful-window evidence must span [from, to].
function adsCoverageProof(adsEvidence, from, to) {
  if (adsEvidence.read !== "ok") return { proven: false, reason: "ads-coverage-read-not-ok" };
  if (!Array.isArray(adsEvidence.windows)) return { proven: false, reason: "ads-coverage-windows-not-array" };
  try {
    return windowsProve(adsEvidence.windows, from, to)
      ? { proven: true, reason: null }
      : { proven: false, reason: "ads-coverage-incomplete" };
  } catch (_e) {
    return { proven: false, reason: "ads-coverage-window-malformed" };
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
    const proof = adsCoverageProof(campaignAds, from, to);
    if (!proof.proven) blockedBy.push({ sourceKey: "ads-campaign-date", reason: proof.reason, blocksSales: false });
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
    const proof = adsCoverageProof(asinAds, from, to);
    if (!proof.proven) blockedBy.push({ sourceKey: "ads-asin-date", reason: proof.reason, blocksSales: false });
  }
  for (const accountId of accounts) {
    const snap = fbaSnapshotsByAccount[accountId];
    if (!snap || !snap.validated_at) {
      blockedBy.push({ sourceKey: "fba-inventory-health", reason: "no-validated-snapshot", accountId, blocksSales: false });
    }
  }
  return { ready: blockedBy.filter((b) => b.blocksSales).length === 0, adsReady: !blockedBy.some((b) => b.sourceKey === "ads-asin-date"), blockedBy };
}
