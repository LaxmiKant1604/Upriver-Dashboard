import React, { useState, useMemo, useEffect, useCallback } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, ComposedChart, Line, PieChart, Pie, Cell, Legend } from "recharts";
import { TrendingUp, Info, RefreshCw, AlertTriangle, X, Search, Boxes, ArrowUpDown, ArrowUp, ArrowDown, Download, ReceiptText, Copy, Check, Wallet, BellRing, Pencil, RotateCcw, UsersRound, UserPlus, LogOut, ShieldCheck, CalendarRange, BarChart3, Inbox, DatabaseZap, Upload, SlidersHorizontal } from "lucide-react";
import { supabase } from "./lib/supabase.js";
// The whole workspace is styled from one token-based stylesheet. Every current
// and future report must build on these tokens and shared patterns rather than
// introducing its own colours, spacing or radii.
import { STYLE, CHART, DASH_CHART } from "./styles/theme.js";
import {
  BreakdownCard, ChartCard, ChartTooltip, ComparisonMetric, DataQualityAlert,
  EmptyState, ErrorState, MetricCard, ObservedUnitsBreakdown, SegmentedControl, SkeletonChart,
  SkeletonMetricGrid, SkeletonTable, Sparkline, TrendIndicator,
} from "./components/ui.jsx";
import { DateRangeSelector, Sidebar, TopBar, VIEW_TITLES } from "./components/shell.jsx";
// The fluid-motion water/ripple background is an isolated, lazily code-split
// layer (it dynamic-imports Three.js on mount). It carries no report state and
// never re-renders React, so it cannot affect a value, formula or request.
import WaterBackground from "./components/WaterBackground.jsx";
// Display and CSV helpers are shared with the insight report views so both
// render money, dates and units identically. Nothing here converts currency.
import {
  FLAGS, FX, FX_AS_OF, MONTH_ABBR, SYMBOL,
  addDays, compactNumber, daysInMonth, fmtDateHuman, fmtMoney, fmtMoneyCompact,
  fmtPct, fmtRangeLabel, fromUTC, monthBack, monthKeyLabel, monthStart, nInt,
  pad2, parts, pct, shiftMonthRange, toUTC, weekStart, yearStart,
} from "./lib/format.js";
import { marketplaceProfile, marketplaceToday } from "../lib/marketplaces.js";
import { clampRecentDays, DEFAULT_RECENT_DAYS } from "../lib/sku-movement-window.js";
import { csvCell } from "./lib/csv.js";
import {
  computePlanRow as computePlanningRow, resolveHorizon, normalizeHorizon,
  DEFAULT_FORECAST_METHOD, DEFAULT_SAFETY_DAYS, SYSTEM_DEFAULT_HORIZON,
} from "./lib/fba-planning.js";
import { validateWarehouseImport, validateWarehouseRows, buildImportTemplateCsv, IMPORT_COLUMNS } from "./lib/warehouse-import.js";
import { matchesPlanBrand, UNMAPPED_BRAND } from "./lib/plan-brand.js";
import { formatDailyRoi, formatDailyAcos, formatDailyTacos } from "./lib/daily-metrics.js";
import { canonicalBrandKey, permittedBrandKeySetForAccount, filterBrandNamesToPermitted } from "./lib/brand-scope-filter.js";
import SalesMovers from "./views/SalesMovers.jsx";
import SkuMovement from "./views/SkuMovement.jsx";
import DailyReporting from "./views/DailyReporting.jsx";
import ListingHealth from "./views/ListingHealth.jsx";
import BuyBoxLoss from "./views/BuyBoxLoss.jsx";
import ReturnsLeakage from "./views/ReturnsLeakage.jsx";
import PpcPerformance from "./views/PpcPerformance.jsx";
import CampaignAds from "./views/CampaignAds.jsx";
import { CAMPAIGN_ADS_TAB } from "./lib/feature-flags.js";
import ListingOptimizer from "./views/ListingOptimizer.jsx";
import PriorityFeed from "./views/PriorityFeed.jsx";
// Account-scoped Brand View (Account -> Brand -> Brand Reports). Deliberately a
// separate view key and a separate module: it owns all of its own state and
// shares no cache key, report key or calculation with the Account View
// dashboard or with the older portfolio brand mode below.
import BrandView from "./views/BrandView.jsx";
// The cross-account portfolio Brand View reached from the header's `Brand view`
// switcher. It renders the same three reports through the same shared tables,
// currency system and exports as BrandView above; only the account set differs.
import BrandPortfolio from "./views/BrandPortfolio.jsx";
import DataSyncCenter from "./views/DataSyncCenter.jsx";

const INITIAL_ADMIN_EMAIL = "laxmikant@upriver.in";

/* ============================== DAILY REPORT HELPERS ============================== */
// Column set for the daily report: `monthsBack` completed months, the current
// month (MTD, up to `latest`), then the last `days` days ending at `latest`.
function dailyReportColumns(latest, monthsBack, days) {
  const cols = [];
  for (let i = monthsBack; i >= 1; i--) {
    const mb = monthBack(latest, i);
    cols.push({ key: `m${mb.y}-${mb.m}`, group: "month", label: `${MONTH_ABBR[mb.m - 1]} '${String(mb.y).slice(2)}`, from: mb.from, to: mb.to });
  }
  const cur = parts(latest);
  cols.push({ key: "mtd", group: "mtd", label: `${MONTH_ABBR[cur.m - 1]} '${String(cur.y).slice(2)} MTD`, from: monthStart(latest), to: latest });
  for (let d = days - 1; d >= 0; d--) {
    const day = addDays(latest, -d);
    const p = parts(day);
    cols.push({ key: `d${day}`, group: "day", label: `${p.d}-${MONTH_ABBR[p.m - 1]}`, from: day, to: day });
  }
  return cols;
}

// The daily API returns these advertising fields. Keep a few aliases so the
// table stays resilient if DataDoe changes an export field name later.
const AD_SALES_KEYS = ["ad_sales", "advertising_sales", "ppc_sales", "sponsored_products_sales", "attributed_sales"];
const AD_SPEND_KEYS = ["ad_spend", "ad_spends", "advertising_spend", "ppc_spend", "spend", "cost"];
const CLICKS_KEYS = ["clicks", "total_clicks", "ad_clicks"];
function pickNum(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== "") return Number(row[k]) || 0;
  }
  return null;
}

/* ============================== KEYWORD RANK HELPERS ============================== */
// SQP reports one child-ASIN/query/period row. These helpers retain the
// source's query-total denominators while computing every share and trend in
// the browser. This lets account/brand/ASIN/search/status changes stay local.
function sqpNumber(value) { return Number(value) || 0; }
function sqpRatio(numerator, denominator) { return denominator > 0 ? numerator / denominator : 0; }
function sqpPercent(value) { return `${(Number(value || 0) * 100).toFixed(1)}%`; }
function sqpSignedPoints(value) {
  const points = Number(value || 0) * 100;
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)}pp`;
}
function sqpStatusMeta(key) {
  return {
    lost: { label: "Lost", tone: "bad", lever: "Check suppression, stock, and Buy Box" },
    slipping: { label: "Slipping", tone: "bad", lever: "Confirm term in listing; add ad support" },
    rising: { label: "Rising", tone: "good", lever: "Protect rank and scale ads" },
    emerging: { label: "Emerging", tone: "warn", lever: "Index the term and test ads" },
    stable: { label: "Stable", tone: "neutral", lever: "Monitor" },
    baseline: { label: "Baseline", tone: "neutral", lever: "History is still building" },
  }[key] || { label: "Stable", tone: "neutral", lever: "Monitor" };
}
function sqpStatusPriority(key) {
  return ({ lost: 0, slipping: 1, emerging: 2, rising: 3, stable: 4, baseline: 5 })[key] ?? 6;
}
function sqpAverage(points, accessor) {
  if (!points.length) return 0;
  return points.reduce((sum, point) => sum + accessor(point), 0) / points.length;
}
function buildKeywordRows(data, selectedBrand) {
  if (!data?.rows?.length) return [];
  const productByAsin = new Map((data.products || []).map((product) => [product.asin, product]));
  const grouped = new Map();
  for (const row of data.rows) {
    const asin = String(row.child_asin || "").trim();
    const query = String(row.search_query || "").trim();
    if (!asin || !query) continue;
    const product = productByAsin.get(asin) || { asin, name: null, brand: "Unassigned" };
    if (selectedBrand !== "ALL" && product.brand !== selectedBrand) continue;
    const key = `${asin}|${query}`;
    const current = grouped.get(key) || { asin, query, productName: product.name, brand: product.brand, byDate: new Map() };
    const date = String(row.date || "");
    if (!date) continue;
    // A defensive merge protects share denominators if DataDoe ever emits a
    // duplicate raw row for the same ASIN/query/period.
    const point = current.byDate.get(date) || { date, volume: 0, totalImpressions: 0, totalClicks: 0, totalPurchases: 0, impressions: 0, clicks: 0, purchases: 0, rank: null };
    point.volume = Math.max(point.volume, sqpNumber(row.search_query_volume));
    point.totalImpressions = Math.max(point.totalImpressions, sqpNumber(row.search_query_total_impression_count));
    point.totalClicks = Math.max(point.totalClicks, sqpNumber(row.search_query_total_click_count));
    point.totalPurchases = Math.max(point.totalPurchases, sqpNumber(row.search_query_total_purchase_count));
    point.impressions += sqpNumber(row.child_asin_impression_count);
    point.clicks += sqpNumber(row.child_asin_click_count);
    point.purchases += sqpNumber(row.child_asin_purchase_count);
    const rank = sqpNumber(row.child_asin_organic_search_rank);
    if (rank > 0) point.rank = point.rank === null ? rank : Math.min(point.rank, rank);
    current.byDate.set(date, point);
    grouped.set(key, current);
  }
  return [...grouped.values()].map((group) => {
    const points = [...group.byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).map((point) => ({
      ...point,
      impressionShare: sqpRatio(point.impressions, point.totalImpressions),
      clickShare: sqpRatio(point.clicks, point.totalClicks),
      purchaseShare: sqpRatio(point.purchases, point.totalPurchases),
      conversionRate: sqpRatio(point.purchases, point.clicks),
    }));
    const totalPurchases = points.reduce((sum, point) => sum + point.purchases, 0);
    const totalVolume = points.reduce((sum, point) => sum + point.volume, 0);
    // Money keywords are terms that actually generated a purchase for this
    // ASIN. This intentionally keeps the alert list short and actionable.
    if (!totalPurchases || !totalVolume) return null;
    const latest = points[points.length - 1];
    const trendReady = data.cadence === "weekly" ? points.length >= 4 : data.cadence === "monthly" ? points.length >= 2 : false;
    const windowSize = points.length >= 6 ? 3 : points.length >= 4 ? 2 : 1;
    const recent = trendReady ? points.slice(-windowSize) : [];
    const prior = trendReady ? points.slice(-windowSize * 2, -windowSize) : [];
    const recentImpressionShare = sqpAverage(recent, (point) => point.impressionShare);
    const priorImpressionShare = sqpAverage(prior, (point) => point.impressionShare);
    const recentRank = sqpAverage(recent.filter((point) => point.rank !== null), (point) => point.rank);
    const priorRank = sqpAverage(prior.filter((point) => point.rank !== null), (point) => point.rank);
    const recentVolume = sqpAverage(recent, (point) => point.volume);
    const priorVolume = sqpAverage(prior, (point) => point.volume);
    const shareDelta = trendReady ? recentImpressionShare - priorImpressionShare : 0;
    const rankDelta = trendReady && recentRank && priorRank ? recentRank - priorRank : 0;
    const volumeGrowth = trendReady && priorVolume > 0 ? (recentVolume - priorVolume) / priorVolume : 0;
    let status = "baseline";
    if (trendReady) {
      const shareCollapsed = latest.impressionShare <= 0.005 && priorImpressionShare >= 0.01;
      const rankLost = latest.rank !== null && latest.rank >= 95 && priorRank > 0 && priorRank < 80;
      const shareFalling = priorImpressionShare > 0 && recentImpressionShare < priorImpressionShare * 0.75;
      const rankWorsening = rankDelta >= 5;
      const shareRising = priorImpressionShare > 0 && recentImpressionShare > priorImpressionShare * 1.25;
      const rankImproving = rankDelta <= -5;
      const isEmerging = volumeGrowth >= 0.25 && latest.impressionShare < 0.03;
      if (shareCollapsed || rankLost) status = "lost";
      else if (shareFalling || rankWorsening) status = "slipping";
      else if (isEmerging) status = "emerging";
      else if (shareRising || rankImproving) status = "rising";
      else status = "stable";
    }
    const averagePurchaseShare = sqpAverage(points, (point) => point.purchaseShare);
    return {
      asin: group.asin,
      productName: group.productName,
      brand: group.brand,
      query: group.query,
      points,
      latest,
      periods: points.length,
      status,
      statusMeta: sqpStatusMeta(status),
      moneyScore: sqpAverage(points, (point) => point.volume) * averagePurchaseShare,
      impressionShareDelta: shareDelta,
      rankDelta,
      volumeGrowth,
      recentImpressionShare,
      priorImpressionShare,
      recentRank: recentRank || latest.rank,
      priorRank: priorRank || null,
      conversionRate: sqpRatio(totalPurchases, points.reduce((sum, point) => sum + point.clicks, 0)),
    };
  }).filter(Boolean);
}

/* ============================== FBA SHIPMENT PLAN HELPERS ============================== */
// Turn one raw per-ASIN plan row + report metadata + the target-coverage input
// into all derived planning metrics. Pure and local, so changing the target or
// filters recomputes instantly without any DataDoe request.
function computePlanRow(r, meta, targetDays) {
  const keys = (meta.months || []).map((m) => m.key);
  const m1 = Number(r.unitsByMonth?.[keys[0]] || 0);
  const m2 = Number(r.unitsByMonth?.[keys[1]] || 0);
  const m3 = Number(r.unitsByMonth?.[keys[2]] || 0);
  const mtdUnits = Number(r.mtdUnits || 0);

  const threeMoAvg = (m1 + m2 + m3) / 3;
  const daysInMonth = Number(meta.currentMonth?.daysInMonth || 0);
  const elapsed = Number(meta.elapsedDays || 0);
  const mtdProjected = elapsed > 0 ? (mtdUnits / elapsed) * daysInMonth : 0;
  const planningAvg = Math.max(threeMoAvg, mtdProjected);
  const dailyRate = daysInMonth > 0 ? planningAvg / daysInMonth : 0;
  const targetUnits = dailyRate * Number(targetDays || 0);

  // Inventory may be unavailable (null) for the whole snapshot; keep planning
  // fields null in that case rather than treating unknown stock as zero.
  const invKnown = r.fbaAvailable !== null && r.fbaAvailable !== undefined;
  const fba = Number(r.fbaAvailable || 0);
  const reserved = Number(r.reservedFcTransfer || 0) + Number(r.reservedFcProcessing || 0);
  const inTransit = Number(r.inboundShipped || 0) + Number(r.inboundReceived || 0);
  const isUS = !!meta.isUS;
  const awd = isUS ? Number(r.awdAvailable || 0) : 0;
  // FBA days cover intentionally uses only physically available FBA units.
  // Reserved, inbound, and AWD stock remain part of the shipment-plan total.
  const mtdDrr = elapsed > 0 ? mtdUnits / elapsed : null;
  const fbaDaysCover = invKnown && mtdDrr && mtdDrr > 0 ? fba / mtdDrr : null;

  const coverage = invKnown ? fba + reserved + inTransit + awd : null;
  const recommended = invKnown ? Math.max(0, Math.ceil(targetUnits - fba - reserved - inTransit - awd)) : null;
  const remark = recommended === null ? null : recommended > 0 ? "Restock" : "OK";

  return {
    asin: r.asin,
    productName: r.productName,
    brand: r.brand,
    sku: r.sku,
    m1, m2, m3, mtdUnits,
    threeMoAvg, mtdProjected, planningAvg, targetUnits,
    fbaAvailable: invKnown ? fba : null,
    mtdDrr,
    fbaDaysCover,
    reserved: invKnown ? reserved : null,
    inTransit: invKnown ? inTransit : null,
    awd: isUS ? (invKnown || r.awdAvailable != null ? awd : null) : null,
    coverage, recommended, remark, invKnown, isUS,
  };
}

function planSearchMatch(row, q) {
  if (!q) return true;
  const hay = `${row.asin || ""} ${row.sku || ""} ${row.productName || ""} ${row.brand || ""}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

// Sortable columns for the plan table. `get` returns a comparable value; null
// values always sort last regardless of direction.
const PLAN_SORT_ACCESSORS = {
  asin: (r) => r.asin || "",
  productName: (r) => (r.productName || "").toLowerCase(),
  brand: (r) => (r.brand || "").toLowerCase(),
  m1: (r) => r.m1, m2: (r) => r.m2, m3: (r) => r.m3,
  mtdUnits: (r) => r.mtdUnits,
  threeMoAvg: (r) => r.planning?.threeMonthAverage,
  mtdProjected: (r) => r.planning?.mtdProjectedUnits,
  planningAvg: (r) => r.planningAvg,
  targetUnits: (r) => r.targetUnits,
  fbaAvailable: (r) => r.fbaAvailable,
  fbaDaysCover: (r) => r.fbaDaysCover,
  custReserved: (r) => r.planning?.customerOrderReserved,
  reserved: (r) => r.reserved,
  inboundPipeline: (r) => r.inboundPipeline,
  awd: (r) => r.awd,
  awdInbound: (r) => r.awdInbound,
  totalFbaInv: (r) => r.totalFbaInv,
  amazonNetwork: (r) => r.amazonNetwork,
  recommended: (r) => r.recommended,
  remark: (r) => r.remark || "",
};

function comparePlanRows(a, b, key, dir) {
  const acc = PLAN_SORT_ACCESSORS[key] || PLAN_SORT_ACCESSORS.recommended;
  const av = acc(a), bv = acc(b);
  const aNull = av === null || av === undefined;
  const bNull = bv === null || bv === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1;   // nulls always last
  if (bNull) return -1;
  let cmp;
  if (typeof av === "string" || typeof bv === "string") cmp = String(av).localeCompare(String(bv));
  else cmp = av - bv;
  return dir === "asc" ? cmp : -cmp;
}

// Per-column export value (raw number/string; null -> "" so a missing value is blank, never a fabricated 0). The
// identity column expands to Product Name / ASIN / SKU / Brand; every other column mirrors exactly what the table
// shows, from the SAME canonical model. Keyed by column id so the export can never diverge from the visible columns.
// Columns hidden by DEFAULT (each raw FBA state has its own column per the spec, but the default view shows the
// combined Reserved (FC) / Inbound Pipeline; the raw components are revealable via the column chooser). "Reset
// default" restores exactly this set; "Select all" reveals everything.
const PLAN_DEFAULT_HIDDEN_COLS = ["reservedFcTransfer", "reservedFcProcessing", "inboundWorking", "inboundShipped", "inboundReceived"];
const expNum = (v) => (v == null || !Number.isFinite(Number(v)) ? "" : Math.round(Number(v)));
const PLAN_EXPORT_VALUES = {
  m1: (r) => expNum(r.monthsDisplay?.[0]), m2: (r) => expNum(r.monthsDisplay?.[1]), m3: (r) => expNum(r.monthsDisplay?.[2]),
  mtdUnits: (r) => expNum(r.mtdUnits), threeMoAvg: (r) => expNum(r.planning?.threeMonthAverage), mtdProjected: (r) => expNum(r.planning?.mtdProjectedUnits),
  targetUnits: (r) => expNum(r.targetUnits), fbaAvailable: (r) => expNum(r.fbaAvailable), fbaDaysCover: (r) => expNum(r.fbaDaysCover),
  custReserved: (r) => expNum(r.planning?.customerOrderReserved), reserved: (r) => expNum(r.reserved), inboundPipeline: (r) => expNum(r.inboundPipeline),
  reservedFcTransfer: (r) => expNum(r.planning?.reservedFcTransfer), reservedFcProcessing: (r) => expNum(r.planning?.reservedFcProcessing),
  inboundWorking: (r) => expNum(r.planning?.inboundWorking), inboundShipped: (r) => expNum(r.planning?.inboundShipped), inboundReceived: (r) => expNum(r.planning?.inboundReceived),
  awd: (r) => expNum(r.awd), awdInbound: (r) => expNum(r.awdInbound), totalFbaInv: (r) => expNum(r.totalFbaInv), amazonNetwork: (r) => expNum(r.amazonNetwork),
  recommended: (r) => expNum(r.recommended), pipeline: (r) => expNum(r.planning?.amazonPipeline), horizon: (r) => horizonLabel(r.effectiveHorizon),
  horizonDemand: (r) => expNum(r.planning?.horizonDemand), safety: (r) => expNum(r.planning?.safetyStockUnits), targetInv: (r) => expNum(r.planning?.targetInventory),
  sellerWh: (r) => expNum(r.planning?.sellerWarehouseQty), shipWh: (r) => expNum(r.planning?.shipFromSellerWarehouse), produce: (r) => expNum(r.planning?.productionRequirement),
  stockout: (r) => r.planning?.estimatedStockoutDate || "", priority: (r) => r.planning?.planningPriority || "", remark: (r) => r.remark || "",
};

// Export EXACTLY the currently-visible/authorized columns, in order, from the one canonical model.
function downloadPlanSpreadsheet(visibleColumns, rows, meta) {
  const exportRows = rows.map((row) => {
    const rec = {};
    for (const c of visibleColumns) {
      if (c.id === "asin") { rec["Product Name"] = row.productName || ""; rec.ASIN = row.asin || ""; rec.SKU = row.sku || ""; rec.Brand = row.brand || ""; continue; }
      const fn = PLAN_EXPORT_VALUES[c.id];
      if (fn) rec[c.label] = fn(row);
    }
    return rec;
  });
  if (exportRows.length === 0) return;
  const headers = Object.keys(exportRows[0]);
  const csv = "\uFEFF" + [headers, ...exportRows.map((row) => headers.map((header) => row[header]))]
    .map((line) => line.map(csvCell).join(","))
    .join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  const account = String(meta.accountName || "account").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  link.href = url;
  link.download = `fba-shipment-plan-${account || "account"}-${meta.asOf || "report"}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

// Durable, per-seller Planning Settings: horizon (1/2/3-month preset or 1-365 custom days) + forecast method
// (+ weights, which must total 100) + safety days. Every change persists server-side (onSave) and the plan
// recomputes locally with ZERO DataDoe. `settings` = the resolved account defaults.
function PlanningSettingsBar({ settings, onSave, busy }) {
  const isDays = settings.horizon.kind === "days";
  const [customDays, setCustomDays] = useState(isDays ? String(settings.horizon.days) : "45");
  const [weights, setWeights] = useState(() => (Array.isArray(settings.forecastWeights) ? settings.forecastWeights : [25, 25, 25, 25]).map(String));
  useEffect(() => { if (settings.horizon.kind === "days") setCustomDays(String(settings.horizon.days)); }, [settings.horizon]);
  useEffect(() => { if (Array.isArray(settings.forecastWeights)) setWeights(settings.forecastWeights.map(String)); }, [settings.forecastWeights]);
  const weightSum = weights.reduce((s, w) => s + (Number(w) || 0), 0);
  const setMonths = (m) => onSave({ horizon: { kind: "months", months: m } });
  const setCustom = () => { const d = Math.trunc(Number(customDays)); if (Number.isInteger(d) && d >= 1 && d <= 365) onSave({ horizon: { kind: "days", days: d } }); };
  return (
    <div className="plan-settings" role="group" aria-label="Planning settings">
      <div className="plan-set-group">
        <span className="plan-field-label">Planning horizon</span>
        <div className="plan-seg">
          {[1, 2, 3].map((m) => (
            <button key={m} type="button" disabled={busy} aria-pressed={!isDays && settings.horizon.months === m}
              className={"plan-seg-btn" + (!isDays && settings.horizon.months === m ? " active" : "")} onClick={() => setMonths(m)}>{m}M</button>
          ))}
          <span className={"plan-seg-custom" + (isDays ? " active" : "")}>
            <input type="number" min="1" max="365" step="1" aria-label="Custom horizon days" value={customDays}
              onChange={(e) => setCustomDays(e.target.value)} onBlur={setCustom}
              onKeyDown={(e) => { if (e.key === "Enter") setCustom(); }} disabled={busy} />
            <span>days</span>
          </span>
        </div>
      </div>
      <label className="plan-set-group">
        <span className="plan-field-label">Forecast method</span>
        <select value={settings.forecastMethod} disabled={busy} onChange={(e) => onSave({ forecastMethod: e.target.value, forecastWeights: e.target.value === "weighted" ? weights.map(Number) : undefined })}>
          <option value="three-month">3-month average</option>
          <option value="mtd">MTD projected</option>
          <option value="higher">Higher of the two</option>
          <option value="weighted">Weighted</option>
        </select>
      </label>
      {settings.forecastMethod === "weighted" && (
        <div className="plan-set-group">
          <span className="plan-field-label">Weights % (M1·M2·M3·MTD, total 100)</span>
          <div className="plan-weights">
            {weights.map((w, i) => (
              <input key={i} type="number" min="0" step="1" value={w} disabled={busy} aria-label={`Weight ${i + 1}`}
                onChange={(e) => setWeights(weights.map((x, j) => (j === i ? e.target.value : x)))} />
            ))}
            <span className={"plan-weight-sum" + (weightSum === 100 ? " ok" : " bad")}>{weightSum}%</span>
            <button type="button" className="plan-mini-btn" disabled={busy || weightSum !== 100} onClick={() => onSave({ forecastMethod: "weighted", forecastWeights: weights.map(Number) })}>Apply</button>
          </div>
        </div>
      )}
      <label className="plan-set-group">
        <span className="plan-field-label">Safety days</span>
        <input type="number" min="0" max="365" step="1" defaultValue={settings.safetyDays} disabled={busy}
          onBlur={(e) => { const d = Math.trunc(Number(e.target.value)); if (Number.isInteger(d) && d >= 0 && d <= 365 && d !== settings.safetyDays) onSave({ safetyDays: d }); }} />
      </label>
    </div>
  );
}

// Inline editor for one SKU's seller-warehouse units (nonnegative whole units). A blank commit is ignored; saving
// persists durably (onSave) and the plan recomputes locally. Amazon-source inventory is never touched.
function WarehouseCell({ row, onSave, busy }) {
  const [editing, setEditing] = useState(false);
  const qty = row.warehouse ? row.warehouse.qty : null;
  const marketplace = row.marketplace;
  if (!row.sku || !marketplace) return <td className="mono"><span className="dr-dash">—</span></td>;
  const commit = (raw) => {
    const t = String(raw).trim();
    if (t !== "") { const n = Math.trunc(Number(t)); if (Number.isInteger(n) && n >= 0) onSave({ sku: row.sku, marketplace, childAsin: row.asin, qty: n }); }
    setEditing(false);
  };
  return (
    <td className="mono plan-wh-cell">
      {editing ? (
        <input autoFocus type="number" min="0" step="1" defaultValue={qty == null ? "" : qty} disabled={busy}
          onBlur={(e) => commit(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") commit(e.target.value); if (e.key === "Escape") setEditing(false); }} />
      ) : (
        <button type="button" className="plan-wh-btn" title={`Edit seller warehouse units${row.warehouse?.updatedByEmail ? ` (last by ${row.warehouse.updatedByEmail})` : ""}`} onClick={() => setEditing(true)}>
          {qty == null ? <span className="plan-wh-empty">+ add</span> : nInt(qty)}
        </button>
      )}
    </td>
  );
}

// A compact label for a resolved horizon: {kind:"months",months:2} -> "2M"; {kind:"days",days:45} -> "45d".
function horizonLabel(h) {
  if (!h) return "—";
  if (h.kind === "days") return `${h.days}d`;
  return `${h.months}M`;
}

// One row's effective planning horizon with a click to open the per-SKU override editor. A SKU with an override
// carries a dot; a row without a SKU can't be overridden (shows the inherited value, not editable).
function SkuHorizonCell({ row, onOpen }) {
  const label = horizonLabel(row.effectiveHorizon);
  if (!row.sku) return <td className="mono"><span className="dr-dash" title="No SKU -- uses the account default">{label}</span></td>;
  const src = row.horizonSource === "sku" ? "per-SKU override" : row.horizonSource === "account" ? "account default" : "system default";
  return (
    <td className="mono">
      <button type="button" className={"plan-horizon-btn" + (row.skuHasOverride ? " has-override" : "")}
        title={`Horizon: ${label} (${src}). Click to set a per-SKU override.`} onClick={() => onOpen(row)}>
        {label}{row.skuHasOverride && <span className="plan-horizon-dot" aria-label="per-SKU override" />}
      </button>
    </td>
  );
}

// Popover editor for ONE SKU's horizon override: choose 1/2/3 months or custom days, or reset to inherit the
// account default. Save persists durably; the plan recomputes locally with zero DataDoe.
function SkuHorizonEditor({ target, accountDefault, onSave, onClose, busy }) {
  const [days, setDays] = useState(target.effective?.kind === "days" ? String(target.effective.days) : "45");
  if (!target) return null;
  const isDays = target.effective?.kind === "days" && target.source === "sku";
  const monthActive = (m) => target.source === "sku" && target.effective?.kind === "months" && target.effective.months === m;
  const commitDays = () => { const d = Math.trunc(Number(days)); if (Number.isInteger(d) && d >= 1 && d <= 365) onSave({ sku: target.sku, horizon: { kind: "days", days: d } }); };
  return (
    <div className="plan-modal-backdrop" onClick={onClose}>
      <div className="plan-modal plan-modal-sm" role="dialog" aria-label="SKU horizon override" onClick={(e) => e.stopPropagation()}>
        <div className="plan-modal-head">
          <div><div className="plan-modal-title">Planning horizon</div><div className="plan-modal-sub mono">{target.sku}{target.asin ? ` · ${target.asin}` : ""}</div></div>
          <button type="button" className="plan-icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="plan-modal-body">
          <p className="plan-modal-note">Currently <strong>{horizonLabel(target.effective)}</strong> from the {target.source === "sku" ? "per-SKU override" : target.source === "account" ? "account default" : "system default"}. Set an override for this SKU or reset to inherit the account default ({horizonLabel(accountDefault)}).</p>
          <div className="plan-seg" style={{ marginBottom: 10 }}>
            {[1, 2, 3].map((m) => (
              <button key={m} type="button" disabled={busy} aria-pressed={monthActive(m)} className={"plan-seg-btn" + (monthActive(m) ? " active" : "")} onClick={() => onSave({ sku: target.sku, horizon: { kind: "months", months: m } })}>{m}M</button>
            ))}
            <span className={"plan-seg-custom" + (isDays ? " active" : "")}>
              <input type="number" min="1" max="365" step="1" aria-label="Custom horizon days" value={days} disabled={busy}
                onChange={(e) => setDays(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") commitDays(); }} />
              <span>days</span>
              <button type="button" className="plan-mini-btn" disabled={busy} onClick={commitDays}>Set</button>
            </span>
          </div>
          <button type="button" className="plan-reset-link" disabled={busy || target.source !== "sku"} onClick={() => onSave({ sku: target.sku, clear: true })}>
            <RotateCcw size={13} /> Reset to account default
          </button>
        </div>
      </div>
    </div>
  );
}

// Grouped show/hide column chooser (per-user prefs). Identity columns are locked visible; AWD columns are omitted
// entirely for non-US accounts (never a fake toggle for data that does not exist).
function PlanColumnChooser({ groups, hidden, isUS, onToggle, onSelectAll, onReset, onClose, busy }) {
  return (
    <div className="plan-cols-pop" role="dialog" aria-label="Choose columns">
      <div className="plan-cols-head">
        <span>Columns</span>
        <div className="plan-cols-actions">
          <button type="button" className="plan-mini-btn" disabled={busy} onClick={onSelectAll}>Select all</button>
          <button type="button" className="plan-mini-btn" disabled={busy} onClick={onReset}>Reset default</button>
          <button type="button" className="plan-icon-btn" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
      </div>
      <div className="plan-cols-body">
        {groups.map((g) => {
          const cols = g.cols.filter((c) => isUS || !c.awd);
          if (cols.length === 0) return null;
          return (
            <div key={g.group} className="plan-cols-group">
              <div className="plan-cols-group-title">{g.group}</div>
              {cols.map((c) => (
                <label key={c.id} className={"plan-cols-item" + (c.locked ? " locked" : "")}>
                  <input type="checkbox" checked={c.locked || !hidden.has(c.id)} disabled={c.locked || busy} onChange={() => onToggle(c.id)} />
                  <span>{c.chooserLabel || c.label}{c.locked && <span className="plan-cols-lock"> · always</span>}</span>
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Seller-warehouse CSV/XLSX bulk importer. Parse -> STRICT validate (isolated to this account's SKUs) -> preview
// valid + error rows -> atomic apply (only when there are ZERO errors). Never touches Amazon-source inventory.
function WarehouseImportModal({ onClose, defaultMarketplace, directory, catalogAsins, hasDirectory, knownSkus, skuAsinMap, onApply }) {
  const [fileName, setFileName] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [result, setResult] = useState(null);
  const [parseError, setParseError] = useState(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(null);
  const [applyError, setApplyError] = useState(null);
  // A v2d-5+ snapshot carries the SKU directory + catalog -> use identity-aware validation; older snapshots fall back
  // to the string allowlist so imports still work (a re-derive upgrades them).
  const opts = hasDirectory ? { defaultMarketplace, directory, catalogAsins } : { defaultMarketplace, knownSkus };

  const runText = (text) => {
    setApplied(null); setApplyError(null); setParseError(null);
    try { setResult(validateWarehouseImport(text, opts)); }
    catch (e) { setParseError(String(e?.message || e)); setResult(null); }
  };
  const onFile = async (file) => {
    if (!file) return;
    setFileName(file.name); setApplied(null); setApplyError(null); setParseError(null);
    try {
      if (/\.xlsx$/i.test(file.name)) {
        const { readXlsxFirstSheet } = await import("./lib/xlsx-read.js");
        const rows = await readXlsxFirstSheet(await file.arrayBuffer());
        setResult(validateWarehouseRows(rows, opts));
      } else {
        runText(await file.text());
      }
    } catch (e) { setParseError(String(e?.message || e)); setResult(null); }
  };
  const downloadTemplate = () => {
    const samples = Array.from(skuAsinMap || new Map()).slice(0, 5).map(([sku, asin]) => ({ sku, childAsin: asin }));
    const csv = buildImportTemplateCsv({ defaultMarketplace, sampleSkus: samples });
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = "seller-warehouse-template.csv"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const canApply = result && result.valid.length > 0 && result.errors.length === 0 && !applying;
  const doApply = async () => {
    if (!canApply) return;
    setApplying(true); setApplyError(null);
    try {
      const rows = result.valid.map((r) => ({ marketplace: r.marketplace, sku: r.sku, qty: r.qty, childAsin: r.childAsin || (skuAsinMap?.get(r.sku) || ""), note: r.note || "" }));
      const res = await onApply(rows);
      setApplied(res?.applied ?? rows.length);
    } catch (e) { setApplyError(String(e?.message || e)); }
    finally { setApplying(false); }
  };

  return (
    <div className="plan-modal-backdrop" onClick={onClose}>
      <div className="plan-modal plan-modal-lg" role="dialog" aria-label="Import seller warehouse" onClick={(e) => e.stopPropagation()}>
        <div className="plan-modal-head">
          <div><div className="plan-modal-title">Import seller warehouse</div><div className="plan-modal-sub">Bulk-set your own warehouse units for this account. CSV, TSV or XLSX. Amazon inventory is never changed.</div></div>
          <button type="button" className="plan-icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="plan-modal-body">
          {applied != null ? (
            <div className="alert success"><Check size={15} /> Imported {applied} warehouse row{applied === 1 ? "" : "s"} for this account. The plan has been recomputed.</div>
          ) : (
            <>
              <div className="plan-import-controls">
                <label className="plan-import-file">
                  <Upload size={14} /> <span>{fileName || "Choose CSV / XLSX file"}</span>
                  <input type="file" accept=".csv,.tsv,.txt,.xlsx" onChange={(e) => onFile(e.target.files?.[0])} />
                </label>
                <button type="button" className="plan-mini-btn" onClick={downloadTemplate}><Download size={13} /> Template</button>
              </div>
              <details className="plan-import-paste">
                <summary>or paste rows (SKU, Marketplace, Warehouse Units, …)</summary>
                <textarea rows={4} value={pasteText} placeholder={IMPORT_COLUMNS.map((c) => c.label).join(",")}
                  onChange={(e) => setPasteText(e.target.value)} onBlur={(e) => e.target.value.trim() && runText(e.target.value)} />
              </details>

              {parseError && <div className="alert error"><AlertTriangle size={15} /> {parseError}</div>}
              {result && result.missingRequired?.length > 0 && (
                <div className="alert error"><AlertTriangle size={15} /> The file is missing required column{result.missingRequired.length === 1 ? "" : "s"}: {result.missingRequired.join(", ")}. Download the template for the exact headers.</div>
              )}
              {result && result.empty && <div className="alert warning">No rows found in the file.</div>}

              {result && !result.empty && result.missingRequired?.length === 0 && (
                <>
                  <div className="plan-import-summary">
                    <span className="plan-import-pill ok"><Check size={13} /> {result.valid.length} ready</span>
                    {result.errors.length > 0 && <span className="plan-import-pill bad"><AlertTriangle size={13} /> {result.errors.length} to fix</span>}
                    {result.duplicates.length > 0 && <span className="plan-import-pill bad">{result.duplicates.length} duplicate{result.duplicates.length === 1 ? "" : "s"}</span>}
                    <span className="plan-import-pill">{result.totalDataRows} total</span>
                  </div>
                  {result.errors.length > 0 && (
                    <div className="plan-import-table-wrap">
                      <table className="plan-import-table">
                        <thead><tr><th>Line</th><th>SKU</th><th>Marketplace</th><th>Units</th><th>Problem</th></tr></thead>
                        <tbody>
                          {result.errors.slice(0, 100).map((e) => (
                            <tr key={e.line} className="bad"><td className="mono">{e.line}</td><td className="mono">{e.sku || "—"}</td><td className="mono">{e.marketplace || "—"}</td><td className="mono">{e.qty == null ? "—" : e.qty}</td><td>{e.problems.join("; ")}</td></tr>
                          ))}
                        </tbody>
                      </table>
                      {result.errors.length > 100 && <div className="plan-import-more">…and {result.errors.length - 100} more</div>}
                    </div>
                  )}
                  {result.valid.length > 0 && (
                    <div className="plan-import-table-wrap">
                      <table className="plan-import-table">
                        <thead><tr><th>SKU</th><th>Marketplace</th><th>Units</th><th>Note</th></tr></thead>
                        <tbody>
                          {result.valid.slice(0, 100).map((r) => (
                            <tr key={r.line}><td className="mono">{r.sku}</td><td className="mono">{r.marketplace}</td><td className="mono">{nInt(r.qty)}</td><td>{r.note || ""}</td></tr>
                          ))}
                        </tbody>
                      </table>
                      {result.valid.length > 100 && <div className="plan-import-more">…and {result.valid.length - 100} more ready to import</div>}
                    </div>
                  )}
                  {applyError && <div className="alert error"><AlertTriangle size={15} /> Import failed (nothing was applied): {applyError}</div>}
                </>
              )}
            </>
          )}
        </div>
        <div className="plan-modal-foot">
          {applied != null ? (
            <button type="button" className="plan-export-btn" onClick={onClose}>Done</button>
          ) : (
            <>
              <span className="plan-modal-foot-note">{result && result.errors.length > 0 ? "Fix every error row before importing — the apply is all-or-nothing." : "The import applies atomically; a single bad row aborts it."}</span>
              <button type="button" className="plan-export-btn" disabled={!canApply} onClick={doApply}>{applying ? "Importing…" : `Import ${result?.valid.length || 0} row${(result?.valid.length || 0) === 1 ? "" : "s"}`}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================== RECONCILIATION HELPERS ============================== */
function sixFullCalendarMonths(today) {
  const p = parts(today);
  const months = [];
  for (let i = 6; i >= 1; i--) {
    const total = p.y * 12 + (p.m - 1) - i;
    const y = Math.floor(total / 12);
    const m = ((total % 12) + 12) % 12 + 1;
    months.push(`${y}-${pad2(m)}`);
  }
  const first = months[0].split("-").map(Number);
  const last = months[months.length - 1].split("-").map(Number);
  return {
    months,
    from: `${first[0]}-${pad2(first[1])}-01`,
    to: `${last[0]}-${pad2(last[1])}-${pad2(daysInMonth(last[0], last[1]))}`,
  };
}

function reconMonthLabel(key) {
  if (!key) return "";
  const [y, m] = key.split("-").map(Number);
  return `${MONTH_ABBR[m - 1]} ${y}`;
}

function reconMonthOf(date) {
  return String(date || "").slice(0, 7);
}

function isCancelledOrder(status) {
  return /cancel/i.test(String(status || ""));
}

function buildReconciliation(raw, selectedBrand) {
  if (!raw) return { orders: [], settlements: [], allSettlementRows: [], brandScopeIsConservative: false };
  const scopeOrders = (raw.orders || []).flatMap((order) => {
    // `brands` is the compact response shape. Keep the breakdown fallback so
    // a pre-existing cached response from the previous schema stays usable.
    const brands = order.brands || Object.keys(order.brandBreakdown || {});
    if (selectedBrand !== "ALL") {
      // Settlement entries are order-level. Only single-brand orders can be
      // attributed faithfully to a product brand, so omit mixed-brand orders.
      if (brands.length !== 1 || brands[0] !== selectedBrand) return [];
      return [order];
    }
    return [order];
  });
  const scopedIds = new Set(scopeOrders.map((order) => order.orderId));
  const allSettlementRows = selectedBrand === "ALL"
    ? (raw.settlements || [])
    : (raw.settlements || []).filter((settlement) => settlement.orderId && scopedIds.has(settlement.orderId));
  const settlementsByOrder = new Map();
  allSettlementRows.forEach((settlement) => {
    if (!settlement.orderId || !scopedIds.has(settlement.orderId)) return;
    const list = settlementsByOrder.get(settlement.orderId) || [];
    list.push(settlement);
    settlementsByOrder.set(settlement.orderId, list);
  });
  const orders = scopeOrders.map((order) => {
    const settlements = settlementsByOrder.get(order.orderId) || [];
    const orderSettlements = settlements.filter((s) => s.settlementType === "ORDER");
    const refundSettlements = settlements.filter((s) => s.settlementType === "REFUND");
    const hasOrderSettlement = orderSettlements.length > 0;
    const hasRefund = refundSettlements.length > 0;
    const reconciliationStatus = isCancelledOrder(order.status) ? "Cancelled"
      : hasOrderSettlement && hasRefund ? "Settled + Refunded"
      : hasRefund ? "Refunded"
      : hasOrderSettlement ? "Settled" : "Pending";
    const settledRevenue = orderSettlements.reduce((sum, s) => sum + Number(s.settledRevenue || 0), 0);
    const settledTax = orderSettlements.reduce((sum, s) => sum + Number(s.settledTax || 0), 0);
    const fees = settlements.reduce((sum, s) => sum + Number(s.referralFee || 0) + Number(s.fbaFee || 0), 0);
    const refundAmount = refundSettlements.reduce((sum, s) => sum + Math.abs(Number(s.refundedAmount || 0)), 0);
    const netPayout = settlements.reduce((sum, s) => sum + Number(s.netPayout || 0), 0);
    const settlementDate = settlements.reduce((latest, s) => !latest || s.settlementDate > latest ? s.settlementDate : latest, null);
    const crossMonth = Boolean(settlementDate && reconMonthOf(settlementDate) !== reconMonthOf(order.orderDate));
    return {
      ...order, settlements, reconciliationStatus, settledRevenue, settledTax, fees,
      refundAmount, netPayout, settlementDate, crossMonth,
      delta: Number(order.orderRevenue || 0) - settledRevenue,
    };
  });
  return { orders, settlements: allSettlementRows.filter((s) => s.orderId && scopedIds.has(s.orderId)), allSettlementRows, brandScopeIsConservative: selectedBrand !== "ALL" };
}

function reconciliationStatusClass(status) {
  return String(status || "").toLowerCase().replace(/[^a-z]+/g, "-");
}

function downloadReconciliationCsv(rows, currency, scopeLabel) {
  const exportRows = rows.map((row) => ({
    "Order ID": row.orderId,
    "Order Date": row.orderDate,
    "Order Month": reconMonthLabel(reconMonthOf(row.orderDate)),
    Status: row.status,
    Channel: row.fulfillmentChannel,
    B2B: row.isBusiness ? "Yes" : "No",
    Quantity: Math.round(row.quantity || 0),
    "Order Revenue": Number(row.orderRevenue || 0).toFixed(2),
    Tax: Number(row.orderTax || 0).toFixed(2),
    "Recon Status": row.reconciliationStatus,
    "Settlement Date": row.settlementDate || "",
    "Settlement Month": row.settlementDate ? reconMonthLabel(reconMonthOf(row.settlementDate)) : "",
    "Settled Revenue": Number(row.settledRevenue || 0).toFixed(2),
    Fees: Number(row.fees || 0).toFixed(2),
    "Refund Amount": Number(row.refundAmount || 0).toFixed(2),
    "Net Payout": Number(row.netPayout || 0).toFixed(2),
    Delta: Number(row.delta || 0).toFixed(2),
    "Cross Month": row.crossMonth ? `Settled in ${reconMonthLabel(reconMonthOf(row.settlementDate))}` : "No",
    Currency: currency || "",
  }));
  if (!exportRows.length) return;
  const headers = Object.keys(exportRows[0]);
  const csv = "\uFEFF" + [headers, ...exportRows.map((row) => headers.map((header) => row[header]))]
    .map((line) => line.map(csvCell).join(","))
    .join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `amazon-reconciliation-${String(scopeLabel || "account").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/* ============================== SKU P&L ANALYZER HELPERS ============================== */
const COGS_OVERRIDE_STORAGE_KEY = "upriver-cogs-overrides-v1";

function readCogsOverrides() {
  try {
    const stored = localStorage.getItem(COGS_OVERRIDE_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}

function cogsOverrideKey(accountId, row) {
  return [accountId || "", row.currency || "", row.sku || "", row.asin || ""].join("|");
}

// Sum a SKU's per-month buckets for the selected month ("ALL" = all six).
function skuPlScopedTotals(byMonth, month) {
  const zero = { sales: 0, profit: 0, cost: 0, adSpend: 0, fees: 0, cogs: 0, units: 0 };
  if (!byMonth) return zero;
  const keys = month && month !== "ALL" ? [month] : Object.keys(byMonth);
  return keys.reduce((acc, key) => {
    const b = byMonth[key];
    if (!b) return acc;
    acc.sales += Number(b.sales || 0);
    acc.profit += Number(b.profit || 0);
    acc.cost += Number(b.cost || 0);
    acc.adSpend += Number(b.adSpend || 0);
    acc.fees += Number(b.fees || 0);
    acc.cogs += Number(b.cogs || 0);
    acc.units += Number(b.units || 0);
    return acc;
  }, { ...zero });
}

// Turn one raw SKU row + the selected month into displayable, recomputed metrics.
// A manual COGS-per-unit override replaces only the COGS component; cost and
// profit move by the same delta so all related P&L metrics stay internally sound.
// Every ratio is derived here from the summed amounts — ratios are never summed.
function computeSkuPlRow(row, month, cogsPerUnitOverride) {
  const t = skuPlScopedTotals(row.byMonth, month);
  const rawCogs = t.cogs;
  const hasCogsOverride = Number.isFinite(cogsPerUnitOverride) && cogsPerUnitOverride >= 0;
  const cogs = hasCogsOverride ? t.units * cogsPerUnitOverride : rawCogs;
  const cogsDelta = cogs - rawCogs;
  const cost = t.cost + cogsDelta;
  const profit = t.profit - cogsDelta;
  // Margin and the ad ratio are recomputed from sums; null when sales is 0 so an
  // undefined ratio is shown as “—” rather than a misleading number.
  const margin = t.sales > 0 ? (profit / t.sales) * 100 : null;
  const adSalesRatio = t.sales > 0 ? (t.adSpend / t.sales) * 100 : null;
  const cogsMissing = t.sales > 0 && cogs <= 0;
  return {
    sku: row.sku, asin: row.asin, productName: row.productName, brand: row.brand, currency: row.currency,
    ...t, cogs, cost, profit, rawCogs, cogsPerUnitOverride: hasCogsOverride ? cogsPerUnitOverride : null,
    hasCogsOverride, margin, adSalesRatio, cogsMissing,
    hasActivity: t.sales !== 0 || profit !== 0 || t.units !== 0 || t.adSpend !== 0,
  };
}

// Primary status/flag for a computed row, given the scope's blended margin.
// Priority: real loss, then a data-quality COGS warning, then ad-heavy, then
// thin margin, else OK. Each returns one concrete next action.
function skuPlStatus(row, blendedMarginPct) {
  if (row.profit < 0) return { key: "loss", label: "Loss", tone: "bad", action: "Raise price or reduce ad bids; review or discontinue." };
  if (row.cogsMissing) return { key: "cogs", label: "Check COGS", tone: "warn", action: "Verify/fix COGS — profit and margin are overstated until COGS is uploaded." };
  if (row.adSpend > row.profit && row.adSpend > 0) return { key: "ad", label: "Ad-heavy", tone: "warn", action: "Reduce ad bids — ad spend is eating the whole profit." };
  if (row.margin !== null && blendedMarginPct !== null && row.margin < 0.5 * blendedMarginPct) return { key: "thin", label: "Thin margin", tone: "warn", action: "Raise price or cut cost — margin is under half the account average." };
  return { key: "ok", label: "OK", tone: "ok", action: null };
}

function skuPlStatusOptionLabel(key) {
  return { ALL: "All statuses", loss: "Loss", cogs: "Check COGS", ad: "Ad-heavy", thin: "Thin margin", ok: "OK" }[key] || key;
}

function downloadSkuPlCsv(rows, currency, monthLabel, accountName) {
  const exportRows = rows.map((r) => ({
    "Product Name": r.productName || "",
    ASIN: r.asin || "",
    SKU: r.sku || "",
    Brand: r.brand || "",
    Currency: r.currency || "",
    Sales: Number(r.sales || 0).toFixed(2),
    Profit: Number(r.profit || 0).toFixed(2),
    "Margin %": r.margin === null ? "" : r.margin.toFixed(1),
    Units: Math.round(r.units || 0),
    "Total Cost": Number(r.cost || 0).toFixed(2),
    "Amazon Fees": Number(r.fees || 0).toFixed(2),
    "Ad Spend": Number(r.adSpend || 0).toFixed(2),
    COGS: Number(r.cogs || 0).toFixed(2),
    "COGS per Unit": r.cogsPerUnitOverride === null ? "" : Number(r.cogsPerUnitOverride).toFixed(2),
    "COGS Source": r.hasCogsOverride ? "Manual override" : "DataDoe",
    "Ad/Sales %": r.adSalesRatio === null ? "" : r.adSalesRatio.toFixed(1),
    Status: r.status?.label || "",
    "Suggested Action": r.status?.action || "",
  }));
  if (!exportRows.length) return;
  const headers = Object.keys(exportRows[0]);
  const csv = "﻿" + [headers, ...exportRows.map((row) => headers.map((h) => row[h]))]
    .map((line) => line.map(csvCell).join(","))
    .join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  const account = String(accountName || "account").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  link.href = url;
  link.download = `sku-pl-${account || "account"}-${(monthLabel || "6-months").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${currency || "cur"}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadContentChangesCsv(events, accountName) {
  const exportRows = events.map((event) => ({
    "Event Time": event.eventTime || "",
    "Notification Type": event.notificationType || "",
    ASINs: (event.asins || []).join(" | "),
    Brands: (event.brands || []).join(" | "),
    "Notification ID": event.notificationId || "",
    Metadata: event.metadataPreview || "",
    "Payload Preview": event.payloadPreview || "",
  }));
  if (!exportRows.length) return;
  const headers = Object.keys(exportRows[0]);
  const csv = "\uFEFF" + [headers, ...exportRows.map((row) => headers.map((header) => row[header]))]
    .map((line) => line.map(csvCell).join(","))
    .join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  const account = String(accountName || "account").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  link.href = url;
  link.download = `content-change-alerts-${account || "account"}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/* ============================== SMALL COMPONENTS ============================== */
// A shared empty Set for breakdown cards that mute nothing. Module-level so it
// keeps a stable identity across renders.
const EMPTY_KEY_SET = new Set();

/**
 * SnapshotGate — the one state a cache-first report shows before it has data.
 *
 * Exactly one of three honest outcomes is rendered: the real upstream error,
 * a skeleton while a request is in flight, or "nothing saved yet" with the
 * Refresh action. It never renders a zeroed layout, because a zero here would
 * be indistinguishable from a real measurement of nothing.
 */
function SnapshotGate({ icon, label, error, loading, notice, onRefresh, busy }) {
  if (error) {
    return (
      <div className="panel">
        <ErrorState
          title={`${label} could not be loaded`}
          message={error}
          onRetry={onRefresh}
          busy={busy}
          retryLabel="Reload latest data"
        />
      </div>
    );
  }
  if (loading) {
    return <div className="panel panel-flush"><SkeletonTable rows={6} /></div>;
  }
  return (
    <div className="panel">
      <EmptyState
        icon={icon}
        title={notice ? "Waiting for the scheduled data refresh" : `Reading the saved ${label}…`}
        actions={onRefresh ? (
          <button className="plan-export-btn" type="button" onClick={onRefresh} disabled={busy}>
            <RefreshCw size={14} className={busy ? "spin" : ""} aria-hidden="true" />
            Reload latest data
          </button>
        ) : null}
      >
        {notice || `Loading the saved ${label} for this account.`}
      </EmptyState>
    </div>
  );
}

function authFetch(path, accessToken, options = {}) {
  return fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  });
}

function LoginScreen({ passwordSetup = false }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [createAdmin, setCreateAdmin] = useState(false);
  const [bootstrapStatus, setBootstrapStatus] = useState(null);

  useEffect(() => {
    if (passwordSetup) return undefined;
    let active = true;
    fetch("/api/access?action=bootstrap-status")
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to check administrator setup.");
        return response.json();
      })
      .then((status) => { if (active) setBootstrapStatus(status); })
      // Fail closed: an unavailable setup check must never offer a second
      // administrator bootstrap path.
      .catch(() => { if (active) setBootstrapStatus({ initialAdminExists: true }); });
    return () => { active = false; };
  }, [passwordSetup]);

  const canCreateInitialAdmin = bootstrapStatus?.initialAdminExists === false;

  const submit = async (event) => {
    event.preventDefault();
    if (!supabase) return;
    setBusy(true); setError(""); setMessage("");
    try {
      if (passwordSetup) {
        if (password.length < 8) throw new Error("Use at least 8 characters for your password.");
        if (password !== confirmPassword) throw new Error("Passwords do not match.");
        const { error: updateError } = await supabase.auth.updateUser({ password });
        if (updateError) throw updateError;
        setMessage("Password saved. Opening your dashboard…");
      } else if (createAdmin) {
        if (email.trim().toLowerCase() !== INITIAL_ADMIN_EMAIL) throw new Error("Only the configured dashboard owner can create the initial administrator login.");
        if (password.length < 8) throw new Error("Use at least 8 characters for your password.");
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(), password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (signUpError) throw signUpError;
        setBootstrapStatus({ initialAdminExists: true, confirmationPending: !data.session });
        setCreateAdmin(false);
        if (!data.session) setMessage("Check your email to confirm this administrator login, then sign in.");
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (signInError) throw signInError;
      }
    } catch (submitError) {
      setError(submitError.message || "Unable to continue.");
    } finally { setBusy(false); }
  };

  return (
    <div className="auth-root">
      <style>{STYLE}</style>
      <form className="auth-panel" onSubmit={submit}>
        <div className="auth-logo">UR</div>
        <div className="auth-title">{passwordSetup ? "Set your password" : createAdmin ? "Create administrator login" : "Upriver Dashboard"}</div>
        <div className="auth-sub">{passwordSetup ? "Choose a password to activate your invited account." : createAdmin ? "Create the one initial administrator identity for this dashboard." : "Sign in to your Amazon reporting workspace."}</div>
        {!passwordSetup && <label className="auth-field"><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required /></label>}
        <label className="auth-field"><span>{passwordSetup ? "New password" : "Password"}</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={passwordSetup ? "new-password" : "current-password"} required minLength="8" /></label>
        {passwordSetup && <label className="auth-field"><span>Confirm password</span><input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" required minLength="8" /></label>}
        {error && <div className="auth-error"><AlertTriangle size={15} />{error}</div>}
        {message && <div className="auth-success">{message}</div>}
        <button className="auth-submit" disabled={busy}>{busy ? "Please wait…" : passwordSetup ? "Save password" : createAdmin ? "Create administrator" : "Sign in"}</button>
        {!passwordSetup && <><div className="auth-note">New users are added by an administrator and receive an email invitation.</div>{canCreateInitialAdmin && <button type="button" className="auth-link" onClick={() => { setCreateAdmin((value) => !value); setError(""); setMessage(""); }}>{createAdmin ? "Back to sign in" : "Create initial administrator login"}</button>}</>}
      </form>
    </div>
  );
}

// Per-account BRAND SCOPE manager (admin). For each account a user is granted, choose "All brands" or "Selected
// brands"; in Selected mode a searchable checklist offers ONLY the account's TRUSTED membership (fetched from the
// server, never fabricated). Saving is atomic + validated server-side; narrowing from All -> Selected warns first.
function BrandScopeManager({ accessToken, userId, grantedAccountIds, accounts }) {
  const [scopes, setScopes] = useState({});     // accountId -> { mode, brandKeys, brandDisplays }
  const [trusted, setTrusted] = useState({});   // accountId -> [{ key, display }]
  const [openAccount, setOpenAccount] = useState("");
  const [draftMode, setDraftMode] = useState("ALL_BRANDS");
  const [draftKeys, setDraftKeys] = useState(() => new Set());
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const nameOf = (id) => { const a = accounts.find((x) => String(x.id) === String(id)); return a ? `${FLAGS[a.country] || ""} ${a.name}` : id; };

  const [caps, setCaps] = useState(() => new Set()); // accounts where this user may manage campaign->brand mapping
  const loadScopes = useCallback(async () => {
    if (!userId) return;
    try { const r = await authFetch(`/api/access?action=user-scopes&userId=${encodeURIComponent(userId)}`, accessToken); const map = {}; for (const s of r.scopes || []) map[s.accountId] = s; setScopes(map); }
    catch (e) { setErr(e.message); }
    try { const c = await authFetch(`/api/access?action=campaign-map-caps&userId=${encodeURIComponent(userId)}`, accessToken); setCaps(new Set((c.capabilities || []).map((x) => x.accountId))); }
    catch { /* capability listing is best-effort; a failure just hides the toggle state */ }
  }, [accessToken, userId]);
  useEffect(() => { loadScopes(); setOpenAccount(""); }, [loadScopes]);

  // Grant/revoke the campaign-brand-mapping capability for ONE account. A grant requires the user to already have
  // account access (enforced server-side); it never widens account/report/brand access.
  const toggleCap = async (accountId) => {
    const grant = !caps.has(accountId);
    setErr(""); setMsg("");
    try {
      await authFetch(`/api/access?action=${grant ? "campaign-map-grant" : "campaign-map-revoke"}`, accessToken, { method: "POST", body: JSON.stringify({ userId, accountId }) });
      setCaps((cur) => { const n = new Set(cur); if (grant) n.add(accountId); else n.delete(accountId); return n; });
      setMsg(grant ? "Campaign-mapping capability granted." : "Campaign-mapping capability revoked.");
    } catch (e) { setErr(e.message || "Could not update the campaign-mapping capability."); }
  };

  const openEditor = async (accountId) => {
    setOpenAccount(accountId); setErr(""); setMsg(""); setSearch("");
    const cur = scopes[accountId] || { mode: "ALL_BRANDS", brandKeys: [] };
    setDraftMode(cur.mode === "SELECTED_BRANDS" ? "SELECTED_BRANDS" : "ALL_BRANDS");
    setDraftKeys(new Set(cur.brandKeys || []));
    if (!trusted[accountId]) {
      try { const r = await authFetch(`/api/access?action=account-brands&accountId=${encodeURIComponent(accountId)}`, accessToken); setTrusted((t) => ({ ...t, [accountId]: r.brands || [] })); }
      catch (e) { setErr(e.message); }
    }
  };
  const toggleKey = (key) => setDraftKeys((cur) => { const n = new Set(cur); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  const save = async () => {
    if (draftMode === "SELECTED_BRANDS" && draftKeys.size === 0) { setErr("Select at least one brand, or choose All brands."); return; }
    const cur = scopes[openAccount];
    if ((!cur || cur.mode !== "SELECTED_BRANDS") && draftMode === "SELECTED_BRANDS") {
      if (!window.confirm(`Narrow this user to only the selected brand(s) for ${nameOf(openAccount)}? They will lose access to this account's other brands.`)) return;
    }
    setBusy(true); setErr(""); setMsg("");
    try {
      const brands = draftMode === "SELECTED_BRANDS" ? (trusted[openAccount] || []).filter((b) => draftKeys.has(b.key)).map((b) => ({ key: b.key, display: b.display })) : [];
      await authFetch("/api/access?action=brand-scope", accessToken, { method: "POST", body: JSON.stringify({ userId, accountId: openAccount, mode: draftMode, brands }) });
      setMsg("Brand access saved."); await loadScopes(); setOpenAccount("");
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const ids = (grantedAccountIds || []).filter(Boolean);
  if (!ids.length) return <div className="empty-note" style={{ marginTop: 8 }}>Grant one or more accounts above and save, then set each account's brand access here.</div>;
  const list = trusted[openAccount] || [];
  const q = search.trim().toLowerCase();
  const shown = q ? list.filter((b) => String(b.display).toLowerCase().includes(q)) : list;

  return <div className="access-brandscope" style={{ marginTop: 12 }}>
    <div className="access-field-label">Brand access per account</div>
    {err && <div className="error-banner"><AlertTriangle size={14} />{err}</div>}
    {msg && <div className="access-notice">{msg}</div>}
    <div className="access-account-list">
      {ids.map((id) => {
        const s = scopes[id] || { mode: "ALL_BRANDS", brandKeys: [] };
        const isSel = s.mode === "SELECTED_BRANDS";
        return <div key={id} className="access-scope-row" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border-default)", flexWrap: "wrap" }}>
          <span style={{ minWidth: 140, flex: "1 1 160px" }}>{nameOf(id)}</span>
          <span className={"access-role " + (isSel ? "role-viewer" : "role-editor")} style={{ whiteSpace: "nowrap" }}>{isSel ? `${(s.brandDisplays || s.brandKeys || []).length} brand${(s.brandDisplays || s.brandKeys || []).length === 1 ? "" : "s"}` : "All brands"}</span>
          <label className="access-account-check" style={{ display: "inline-flex", gap: 6, whiteSpace: "nowrap", fontSize: 12 }} title="Allow this user to map campaigns to brands for this account. Never grants any account, report or brand access.">
            <input type="checkbox" checked={caps.has(id)} onChange={() => toggleCap(id)} /><span>Campaign mapping</span>
          </label>
          <button type="button" className="secondary-action" onClick={() => openEditor(id)} style={{ padding: "3px 10px" }}>Edit brands</button>
        </div>;
      })}
    </div>
    {openAccount && <div className="panel" style={{ marginTop: 10, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <strong>{nameOf(openAccount)}</strong>
        <button type="button" className="icon-action" onClick={() => setOpenAccount("")} title="Close"><X size={15} /></button>
      </div>
      <label className="access-account-check" style={{ display: "flex", gap: 7 }}><input type="radio" name="brandmode" checked={draftMode === "ALL_BRANDS"} onChange={() => setDraftMode("ALL_BRANDS")} /><span>All brands in this account (includes brands added later)</span></label>
      <label className="access-account-check" style={{ display: "flex", gap: 7 }}><input type="radio" name="brandmode" checked={draftMode === "SELECTED_BRANDS"} onChange={() => setDraftMode("SELECTED_BRANDS")} /><span>Selected brands only</span></label>
      {draftMode === "SELECTED_BRANDS" && <div style={{ marginTop: 8 }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search brands…" aria-label="Search brands" style={{ width: "100%", padding: "5px 8px", marginBottom: 6, borderRadius: 6, border: "1px solid var(--border-strong)" }} />
        <div className="access-account-list" style={{ maxHeight: 220, overflowY: "auto" }}>
          {list.length === 0 && <div className="empty-note">No proven brands for this account yet.</div>}
          {shown.map((b) => <label className="access-account-check" key={b.key}><input type="checkbox" checked={draftKeys.has(b.key)} onChange={() => toggleKey(b.key)} /><span>{b.display}</span></label>)}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>{draftKeys.size} selected. A newly discovered brand is NOT added automatically.</div>
      </div>}
      <button type="button" className="auth-submit" onClick={save} disabled={busy} style={{ marginTop: 10 }}>{busy ? "Saving…" : "Save brand access"}</button>
    </div>}
  </div>;
}

function AccessPanel({ accessToken, accounts, onLoadAccounts }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [inviteAccountIds, setInviteAccountIds] = useState([]);
  const [editingUserId, setEditingUserId] = useState("");
  const [editRole, setEditRole] = useState("viewer");
  const [editAccountIds, setEditAccountIds] = useState([]);

  const loadUsers = useCallback(async () => {
    setLoading(true); setError("");
    try { setUsers((await authFetch("/api/access?action=users", accessToken)).users || []); }
    catch (loadError) { setError(loadError.message); }
    finally { setLoading(false); }
  }, [accessToken]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const toggle = (accountId, setter) => setter((current) => current.includes(accountId)
    ? current.filter((id) => id !== accountId)
    : [...current, accountId]);

  const invite = async (event) => {
    event.preventDefault();
    setLoading(true); setError(""); setNotice("");
    try {
      await authFetch("/api/access?action=invite", accessToken, {
        method: "POST",
        body: JSON.stringify({ email, displayName, accountIds: inviteAccountIds }),
      });
      setEmail(""); setDisplayName(""); setInviteAccountIds([]);
      setNotice("Invitation sent and account access assigned.");
      await loadUsers();
    } catch (inviteError) { setError(inviteError.message); }
    finally { setLoading(false); }
  };

  const beginEdit = (user) => {
    setEditingUserId(user.id);
    setEditRole(user.role === "editor" ? "editor" : "viewer");
    setEditAccountIds(user.accountIds || []);
    setNotice(""); setError("");
  };

  const saveEdit = async () => {
    setLoading(true); setError(""); setNotice("");
    try {
      await authFetch("/api/access?action=user", accessToken, {
        method: "PATCH",
        body: JSON.stringify({ userId: editingUserId, role: editRole, accountIds: editAccountIds }),
      });
      setEditingUserId("");
      setNotice("User access updated.");
      await loadUsers();
    } catch (saveError) { setError(saveError.message); }
    finally { setLoading(false); }
  };

  return <div className="container access-page">
    <div className="controls-bar access-heading"><div><div className="page-title">User Access</div><div className="page-sub">Invite users and assign only the Amazon accounts they may access.</div></div><button className="secondary-action" onClick={onLoadAccounts} disabled={loading}><RefreshCw size={14} className={loading ? "spin" : ""} />Load accounts</button></div>
    {error && <div className="error-banner"><AlertTriangle size={15} />{error}</div>}
    {notice && <div className="access-notice">{notice}</div>}
    {!accounts.length && <div className="panel access-empty">Load the account directory before inviting a user, then choose their permitted accounts.</div>}
    <div className="access-grid">
      <form className="panel access-invite" onSubmit={invite}>
        <div className="panel-title"><UserPlus size={17} />Invite user</div>
        <label className="auth-field"><span>Email address</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="user@company.com" /></label>
        <label className="auth-field"><span>Name (optional)</span><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Team member" /></label>
        <div className="access-field-label">Allowed Amazon accounts</div>
        <div className="access-account-list">{accounts.map((account) => <label className="access-account-check" key={account.id}><input type="checkbox" checked={inviteAccountIds.includes(account.id)} onChange={() => toggle(account.id, setInviteAccountIds)} /><span>{FLAGS[account.country] || ""} {account.name}</span></label>)}</div>
        <button className="auth-submit" disabled={loading || !accounts.length}>Send invitation</button>
      </form>
      <div className="panel access-users">
        <div className="panel-title"><UsersRound size={17} />Users</div>
        <div className="access-user-list">{users.map((user) => <button className={"access-user-row" + (editingUserId === user.id ? " selected" : "")} type="button" key={user.id} onClick={() => beginEdit(user)}><span><strong>{user.displayName || user.email}</strong><small>{user.email}</small></span><span className={"access-role role-" + user.role}>{user.role}</span><span>{user.accountIds.length} accounts</span></button>)}</div>
      </div>
    </div>
    {editingUserId && (() => {
      const user = users.find((candidate) => candidate.id === editingUserId);
      if (!user) return null;
      return <div className="panel access-editor"><div className="panel-head"><div><div className="panel-title">Edit access</div><div className="page-sub">{user.email}</div></div><button className="icon-action" type="button" onClick={() => setEditingUserId("")} title="Close"><X size={15} /></button></div>{user.role === "admin" ? <div className="empty-note">The initial administrator remains protected in this panel.</div> : <><label className="auth-field"><span>Role</span><select value={editRole} onChange={(e) => setEditRole(e.target.value)}><option value="viewer">Viewer</option><option value="editor">Editor</option></select></label><div className="access-field-label">Allowed Amazon accounts</div><div className="access-account-list">{accounts.map((account) => <label className="access-account-check" key={account.id}><input type="checkbox" checked={editAccountIds.includes(account.id)} onChange={() => toggle(account.id, setEditAccountIds)} /><span>{FLAGS[account.country] || ""} {account.name}</span></label>)}</div><button className="auth-submit" type="button" onClick={saveEdit} disabled={loading}>Save access</button><BrandScopeManager accessToken={accessToken} userId={user.id} grantedAccountIds={user.accountIds} accounts={accounts} /></>}</div>;
    })()}
  </div>;
}

/* ============================== DATA LAYER ============================== */
let apiAccessToken = "";
let apiCacheOwner = "anonymous";

function configureApiSession(session) {
  apiAccessToken = session?.access_token || "";
  apiCacheOwner = session?.user?.id || "anonymous";
}

async function apiGet(params) {
  if (!apiAccessToken) throw new Error("Please sign in to access the dashboard.");
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`/api/datadoe?${qs}`, { headers: { Authorization: `Bearer ${apiAccessToken}` } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
  return body;
}

const API_CACHE_PREFIX = "upriver:datadoe:v2:";
const LARGE_CACHE_DB = "upriver-report-cache";
const LARGE_CACHE_STORE = "responses";

function apiCacheKey(params) {
  const qs = new URLSearchParams();
  Object.keys(params).sort().forEach((key) => qs.set(key, params[key]));
  return API_CACHE_PREFIX + encodeURIComponent(apiCacheOwner) + ":" + qs.toString();
}

function readApiCache(params) {
  try {
    const raw = window.localStorage.getItem(apiCacheKey(params));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

// Kept as a compatibility name for the existing account selector. The list is
// intentionally taken from that account's saved brand-sales rows, not from an
// unscoped catalog response.
function readCachedCatalogBrands(accountId) {
  return cachedBrandsForAccount(accountId);
}

function removeUnauthorizedCachedData(allowedAccountIds, isAdmin) {
  if (isAdmin) return;
  const allowed = new Set(allowedAccountIds);
  const ownerPrefix = API_CACHE_PREFIX + encodeURIComponent(apiCacheOwner) + ":";
  try {
    const staleKeys = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(ownerPrefix)) continue;
      const accountId = new URLSearchParams(key.slice(ownerPrefix.length)).get("ids");
      if (accountId && !allowed.has(accountId)) staleKeys.push(key);
    }
    staleKeys.forEach((key) => window.localStorage.removeItem(key));
  } catch (e) {
    // Browser storage can be unavailable; server authorization remains final.
  }
}

// Phase 11: a CLIENT access fingerprint mirroring the server's -- changes whenever account access, a brand-scope
// mode, the selected brands, or the role changes. Used to invalidate ALL of this user's cached report data on any
// permission mutation so a broader pre-change payload (or a pre-restriction brand list) can never survive.
function accessFingerprintClient(access) {
  const grants = access && access.accountGrants ? access.accountGrants : {};
  const parts = Object.keys(grants).sort().map((a) => { const g = grants[a] || {}; const keys = Array.isArray(g.brandKeys) ? [...g.brandKeys].sort() : []; return `${a}:${g.mode || "ALL_BRANDS"}:${keys.join("|")}`; });
  return JSON.stringify({ u: (access && access.userId) || "", r: (access && access.role) || "", g: parts });
}
// Remove EVERY cached report entry for the current owner from localStorage (a full purge, regardless of account).
function purgeAllOwnerReportCacheLocal() {
  const ownerPrefix = API_CACHE_PREFIX + encodeURIComponent(apiCacheOwner) + ":";
  try {
    const keys = [];
    for (let i = 0; i < window.localStorage.length; i++) { const k = window.localStorage.key(i); if (k && k.startsWith(ownerPrefix)) keys.push(k); }
    keys.forEach((k) => window.localStorage.removeItem(k));
  } catch (e) { /* storage may be unavailable; server authorization is final */ }
}

function writeApiCache(params, body) {
  const cachedAt = Date.now();
  try {
    window.localStorage.setItem(apiCacheKey(params), JSON.stringify({ body, cachedAt }));
  } catch (e) {
    // Storage can be full or blocked; keep the dashboard usable even then.
  }
  return cachedAt;
}

async function cachedApiGet(params, { force = false } = {}) {
  if (!force) {
    const cached = readApiCache(params);
    if (cached) return { ...cached, fromCache: true };
  }
  const body = await apiGet(params);
  return { body, cachedAt: writeApiCache(params, body), fromCache: false };
}

// Order-level reconciliation data can be much larger than a browser's
// localStorage quota. Store that report in IndexedDB so cache-first remains
// reliable for large accounts; localStorage remains a fallback for browsers
// where IndexedDB is unavailable or blocked.
function openLargeCache() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error("IndexedDB is unavailable")); return; }
    const request = window.indexedDB.open(LARGE_CACHE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(LARGE_CACHE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function readLargeApiCache(params) {
  const key = apiCacheKey(params);
  try {
    const db = await openLargeCache();
    const cached = await new Promise((resolve, reject) => {
      const request = db.transaction(LARGE_CACHE_STORE, "readonly").objectStore(LARGE_CACHE_STORE).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return cached || readApiCache(params);
  } catch (e) {
    return readApiCache(params);
  }
}
async function writeLargeApiCache(params, body) {
  const cachedAt = Date.now();
  const key = apiCacheKey(params);
  try {
    const db = await openLargeCache();
    await new Promise((resolve, reject) => {
      const request = db.transaction(LARGE_CACHE_STORE, "readwrite").objectStore(LARGE_CACHE_STORE).put({ body, cachedAt }, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
    return cachedAt;
  } catch (e) {
    return writeApiCache(params, body);
  }
}
async function cachedLargeApiGet(params, { force = false } = {}) {
  if (!force) {
    const cached = await readLargeApiCache(params);
    if (cached) return { ...cached, fromCache: true };
  }
  const body = await apiGet(params);
  return { body, cachedAt: await writeLargeApiCache(params, body), fromCache: false };
}

/* ===== Shared report layer (the six insight reports) =====
   These reports are stored server-side in Supabase rather than per browser, so
   one person's refresh is visible to every user permitted on that account.
   Two operations exist and only one of them can reach DataDoe:

     loadSharedReport    — reads the saved snapshot. Used on navigation and on
                           every account change. It never calls DataDoe.
     refreshSharedReport — sends refresh=1. The server claims a lock, calls
                           DataDoe once, saves the snapshot for everyone, and
                           publishes a compact "updated" event.

   The browser cache is still written, but only as an instant first paint and an
   offline fallback: the shared snapshot is always the authority, which is why
   `loadSharedReport` issues its request even when a cached copy exists. */
async function loadSharedReport(params) {
  const body = await apiGet(params);
  return { body, cachedAt: await writeLargeApiCache(params, body), fromCache: false };
}

async function refreshSharedReport(params) {
  // `refresh` is deliberately NOT part of the cache key, so a refreshed report
  // and a read of the same scope share one cache entry.
  const body = await apiGet({ ...params, refresh: "1" });
  return { body, cachedAt: await writeLargeApiCache(params, body), fromCache: false };
}

function readSharedReportCache(params) {
  return readLargeApiCache(params);
}

/* ===== Generic automatic report loading (stale-while-revalidate) =====
   ONE shared mechanism every report page uses so the dashboard behaves like a real app: opening a page, or
   changing account / brand / date / report, immediately shows any local cache and then reads the authoritative
   saved Supabase snapshot -- always READ-ONLY (loadSharedReport), so a page visit NEVER spends a DataDoe token.
   It revalidates when the window regains focus and on a restrained interval, keeps the last-known-good visible
   while updating, and guards every response so a slow answer for account A can never land under account B. */
const AUTO_REVALIDATE_MS = 60000;

// Re-run `reload` on window focus / tab-visible and on a restrained interval, but only while `active` and never
// while the tab is hidden. Read-only by contract (callers pass a snapshot READ, never a DataDoe refresh).
function useAutoRevalidate(reload, { active, intervalMs = AUTO_REVALIDATE_MS } = {}) {
  const reloadRef = React.useRef(reload);
  useEffect(() => { reloadRef.current = reload; }, [reload]);
  useEffect(() => {
    if (!active || typeof window === "undefined") return undefined;
    const run = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (reloadRef.current) reloadRef.current();
    };
    const onVisible = () => { if (typeof document === "undefined" || document.visibilityState === "visible") run(); };
    window.addEventListener("focus", run);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    const id = window.setInterval(run, intervalMs);
    return () => {
      window.removeEventListener("focus", run);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(id);
    };
  }, [active, intervalMs]);
}

/**
 * State for one shared insight report.
 *
 * On navigation and on any account change it reads the SHARED snapshot, so a
 * refresh performed by a colleague is visible immediately. The browser copy is
 * painted first purely so the screen is never blank, and it is also the fallback
 * if the shared read fails. Only `refresh()` can reach DataDoe, and an in-flight
 * guard means repeated clicks cannot launch duplicate exports.
 */
function useSharedReport({ params, active }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);   // first paint (no cache yet)
  const [updating, setUpdating] = useState(false);  // revalidating while a last-known-good is shown
  const [error, setError] = useState(null);
  const [cachedAt, setCachedAt] = useState(null);
  const refreshing = React.useRef(false);
  // Monotonic request id: only the newest scope's response is allowed to land, so a slow answer for a previous
  // account/brand/date can never overwrite the current one (no cross-account leak, no stale flash).
  const reqId = React.useRef(0);

  const load = useCallback(async () => {
    if (!params) { setData(null); setCachedAt(null); setError(null); setLoading(false); setUpdating(false); return; }
    const myId = ++reqId.current;
    setError(null);
    let cached = null;
    try { cached = await readSharedReportCache(params); } catch (e) { cached = null; }
    if (myId !== reqId.current) return; // scope changed while reading the browser cache
    if (cached) { setData(cached.body); setCachedAt(new Date(cached.cachedAt)); setUpdating(true); }
    else setLoading(true);
    try {
      const result = await loadSharedReport(params);
      if (myId !== reqId.current) return; // a newer scope superseded this read -> ignore its response
      setData(result.body);
      setCachedAt(new Date(result.cachedAt));
    } catch (loadError) {
      if (myId !== reqId.current) return;
      setError(cached
        ? `Showing the last copy saved in this browser. The shared snapshot could not be read: ${loadError.message}`
        : loadError.message);
    } finally {
      if (myId === reqId.current) { setLoading(false); setUpdating(false); }
    }
  }, [params]);

  useEffect(() => { if (active) load(); }, [active, load]);
  useAutoRevalidate(load, { active });

  const refresh = useCallback(async () => {
    if (!params || refreshing.current) return;
    refreshing.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await refreshSharedReport(params);
      setData(result.body);
      setCachedAt(new Date(result.cachedAt));
    } catch (refreshError) {
      setError(refreshError.message);
    } finally {
      refreshing.current = false;
      setLoading(false);
    }
  }, [params]);

  return { data, loading, updating, error, cachedAt, refresh, reload: load };
}

/**
 * Honours the operating system's reduced-motion setting.
 *
 * The CSS already neutralises transitions under `prefers-reduced-motion`, but
 * recharts animates in JavaScript, so the chart has to be told separately.
 */
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false
  ));
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

// `countryName`, `reportCountry` and `reportCurrency` moved to
// src/lib/brand-view-tables.js and lib/server/reports/brand-view.js with the
// report tables and the aggregation that were their only callers.

// The account dashboard and Brand View both read this same cache shape.  It
// intentionally considers only brand-sales rows, never broad catalog metadata,
// so a brand cannot appear under an account where it has not been observed.
// The CANONICAL brand-key for MATCHING -- delegates to the shared pure helper (src/lib/brand-scope-filter.js), which
// MUST mirror lib/server/reports/brand-membership.js#brandKey so the frontend selects the same brand the server keyed
// its directory/membership map by: trim, collapse interior whitespace, lowercase. Punctuation preserved.
function brandKey(value) {
  return canonicalBrandKey(value);
}

function cachedBrandsForAccount(accountId) {
  if (!accountId) return [];
  try {
    const brands = new Set();
    const ownerPrefix = API_CACHE_PREFIX + encodeURIComponent(apiCacheOwner) + ":";
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(ownerPrefix)) continue;
      const params = new URLSearchParams(key.slice(ownerPrefix.length));
      if (params.get("action") !== "brand-sales" || params.get("ids") !== accountId) continue;
      const cached = JSON.parse(window.localStorage.getItem(key) || "{}");
      (cached.body?.rows || []).forEach((row) => {
        const brand = String(row.product_brand || "").trim();
        if (brand && brand !== "Unassigned") brands.add(brand);
      });
    }
    return [...brands].sort((a, b) => a.localeCompare(b));
  } catch (e) {
    return [];
  }
}

// The former BrandPortfolioDashboard was removed here. The cross-account
// portfolio report it rendered now lives in src/views/BrandPortfolio.jsx and
// shares its tables, currency system and exports with the account-scoped Brand
// View, so the two reports cannot show different numbers for the same data.

/* ============================== MAIN APP ============================== */
function DashboardApp({ session, access, onSignOut }) {
  const isAdmin = access.role === "admin";
  const allowedAccountIds = useMemo(() => new Set(access.accountIds || []), [access.accountIds]);
  useEffect(() => {
    configureApiSession(session);
    // Phase 11: on ANY access-fingerprint change (account added/removed, brand-scope mode, selected brands, role),
    // purge ALL of this user's cached report data so a broader pre-change payload or brand list can never persist.
    try {
      const fpKey = `upriver:accessfp:${access.userId || "anon"}`;
      const fp = accessFingerprintClient(access);
      if (window.localStorage.getItem(fpKey) !== fp) {
        purgeAllOwnerReportCacheLocal();
        void clearAllOwnerLargeCache();
        window.localStorage.setItem(fpKey, fp);
      }
    } catch (e) { /* storage may be unavailable; server authorization is final */ }
    removeUnauthorizedCachedData(access.accountIds || [], isAdmin);
    void removeUnauthorizedLargeCachedData(access.accountIds || [], isAdmin);
  }, [session, access.accountIds, access.accountGrants, access.userId, isAdmin]);

  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState(null);

  const prefersReducedMotion = usePrefersReducedMotion();

  const [rows, setRows] = useState([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState(null);
  const [salesCompleteness, setSalesCompleteness] = useState(null); // two-layer provisional/final D-1 for the Sales Dashboard (brand-sales)
  // "Nothing saved for this scope yet" is a first-run state, not a failure, so
  // it is tracked separately from a real upstream error and rendered as an
  // empty state with a Refresh action instead of a red banner.
  const [rowsCacheMissing, setRowsCacheMissing] = useState(false);
  // The same distinction for the cache-first reports. Only one report is on
  // screen at a time and each one's loader sets or clears this on navigation,
  // so a single shared slot is enough.
  const [snapshotNotice, setSnapshotNotice] = useState(null);
  const [lastFetchedAt, setLastFetchedAt] = useState(null);
  const [catalogBrands, setCatalogBrands] = useState([]);
  const [catalogBrandsAccountId, setCatalogBrandsAccountId] = useState(null);

  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [selectedBrand, setSelectedBrand] = useState("ALL");
  // Account View is the existing selected-account dashboard. Brand View is a
  // deliberately separate portfolio scope: it never changes account-report
  // state or causes background DataDoe requests.
  const [dashboardMode, setDashboardMode] = useState("account");
  const [selectedPortfolioBrand, setSelectedPortfolioBrand] = useState("");
  // The portfolio report's own data, loading, refresh, currency and export
  // state now live inside BrandPortfolio. DashboardApp keeps only the brand
  // selection and the account set that brand maps to.
  // A fresh browser has no cached account catalog. This explicit, manual
  // discovery pass fills the portfolio Brand dropdown before a brand is chosen.
  const [brandDirectoryLoading, setBrandDirectoryLoading] = useState(false);
  const [brandDirectoryError, setBrandDirectoryError] = useState(null);
  const [brandDirectoryProgress, setBrandDirectoryProgress] = useState(null);
  const [brandDirectoryFetchedAt, setBrandDirectoryFetchedAt] = useState(null);
  const [brandDirectoryBrands, setBrandDirectoryBrands] = useState([]);
  const [brandDirectoryAccounts, setBrandDirectoryAccounts] = useState({});
  const [brandDirectoryVersion, setBrandDirectoryVersion] = useState(0);
  const [rangePreset, setRangePreset] = useState("30D");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [granularity, setGranularity] = useState("D");

  // Sidebar shell state: `collapsed` = desktop icon-only mode; `mobileOpen` = drawer open on small screens.
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  // Which section is showing: the main dashboard or the Daily Reporting view.
  const [view, setView] = useState("dashboard");

  // Every report reads this single account/brand scope from the header.
  const [dailyRows, setDailyRows] = useState([]);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyError, setDailyError] = useState(null);
  // true when dailyError is the server's honest "no snapshot yet" state (a typed waiting/unavailable message),
  // false when it is a genuine request failure. The waiting state renders as info, never as a failed refresh.
  const [dailyMissing, setDailyMissing] = useState(false);
  const [dailyCompleteness, setDailyCompleteness] = useState(null); // two-layer provisional/final D-1 completeness (from the serve-time augment)

  // FBA Shipment Plan is cache-first and uses the shared header scope.
  const [planData, setPlanData] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState(null);
  const [planCachedAt, setPlanCachedAt] = useState(null);
  const [targetDays, setTargetDays] = useState(30);
  const [planSearch, setPlanSearch] = useState("");
  const [planSort, setPlanSort] = useState({ key: "recommended", dir: "desc" });
  // Durable, per-seller planning config (settings + SKU horizon overrides + seller warehouse), loaded from the
  // account-scoped API. A settings/warehouse change re-reads this and recomputes locally with ZERO DataDoe.
  const [planConfig, setPlanConfig] = useState(null);
  const [planConfigBusy, setPlanConfigBusy] = useState(false);
  // Per-user column visibility (set of HIDDEN column ids), the SKU-horizon editor target, and the bulk-import modal.
  const [planHiddenCols, setPlanHiddenCols] = useState(() => new Set());
  const [planColsBusy, setPlanColsBusy] = useState(false);
  const [skuHorizonEdit, setSkuHorizonEdit] = useState(null); // { sku, asin, effective, source } | null
  const [warehouseImportOpen, setWarehouseImportOpen] = useState(false);
  // SKU Movement (v2): per-USER window N + hidden columns, persisted via /api/sku-movement-prefs (never DataDoe).
  const [skuRecentDays, setSkuRecentDays] = useState(DEFAULT_RECENT_DAYS);
  const [skuHiddenCols, setSkuHiddenCols] = useState([]);
  const [skuIdentBusy, setSkuIdentBusy] = useState(false);
  // Points at the SKU Movement report's current reload() (declared later); an identifier write re-reads via this ref
  // so the callbacks below don't have to close over the params-dependent report object (which would be a TDZ).
  const skuReloadRef = React.useRef(null);

  // Reconciliation is a six-full-month, cache-first report. Once refreshed,
  // its month selector and Order Explorer operate entirely in the browser.
  const [reconciliationData, setReconciliationData] = useState(null);
  const [reconciliationLoading, setReconciliationLoading] = useState(false);
  const [reconciliationError, setReconciliationError] = useState(null);
  const [reconciliationCachedAt, setReconciliationCachedAt] = useState(null);
  const [reconciliationMonth, setReconciliationMonth] = useState("");
  const [reconciliationMode, setReconciliationMode] = useState("counts");
  const [reconciliationSearch, setReconciliationSearch] = useState("");
  const [reconciliationStatusFilter, setReconciliationStatusFilter] = useState("ALL");
  const [reconciliationReconFilter, setReconciliationReconFilter] = useState("ALL");
  const [reconciliationB2BFilter, setReconciliationB2BFilter] = useState("ALL");
  const [reconciliationCrossMonthFilter, setReconciliationCrossMonthFilter] = useState("ALL");
  const [reconciliationFrom, setReconciliationFrom] = useState("");
  const [reconciliationTo, setReconciliationTo] = useState("");
  const [reconciliationSort, setReconciliationSort] = useState({ key: "orderDate", dir: "desc" });
  const [reconciliationPage, setReconciliationPage] = useState(1);
  const [copiedOrderId, setCopiedOrderId] = useState(null);

  // SKU P&L Analyzer: six-full-month, cache-first report on the shared header
  // scope. Month/currency/search/sort/filter/pagination all run locally.
  const [skuPlData, setSkuPlData] = useState(null);
  const [skuPlLoading, setSkuPlLoading] = useState(false);
  const [skuPlError, setSkuPlError] = useState(null);
  const [skuPlCachedAt, setSkuPlCachedAt] = useState(null);
  const [skuPlMonth, setSkuPlMonth] = useState("");
  const [skuPlCurrency, setSkuPlCurrency] = useState("");
  const [skuPlSearch, setSkuPlSearch] = useState("");
  const [skuPlStatusFilter, setSkuPlStatusFilter] = useState("ALL");
  const [skuPlSort, setSkuPlSort] = useState({ key: "profit", dir: "desc" });
  const [skuPlPage, setSkuPlPage] = useState(1);
  const [cogsOverrides, setCogsOverrides] = useState(readCogsOverrides);
  const [cogsEditRow, setCogsEditRow] = useState(null);
  const [cogsEditValue, setCogsEditValue] = useState("");
  const [cogsEditError, setCogsEditError] = useState("");

  // Content Change Alerts: cache-first, selected-account-only monitoring of
  // Amazon A+ / branded-item content change notifications.
  const [contentChangesData, setContentChangesData] = useState(null);
  const [contentChangesLoading, setContentChangesLoading] = useState(false);
  const [contentChangesError, setContentChangesError] = useState(null);
  const [contentChangesCachedAt, setContentChangesCachedAt] = useState(null);
  const [contentChangesSearch, setContentChangesSearch] = useState("");
  const [contentChangesType, setContentChangesType] = useState("ALL");

  // Keyword Rank & Share Tracker: selected-account SQP snapshots are cached
  // locally; the table's ASIN/search/status controls operate only on that data.
  const [keywordRankData, setKeywordRankData] = useState(null);
  const [keywordRankLoading, setKeywordRankLoading] = useState(false);
  const [keywordRankError, setKeywordRankError] = useState(null);
  const [keywordRankCachedAt, setKeywordRankCachedAt] = useState(null);
  const [keywordRankSearch, setKeywordRankSearch] = useState("");
  const [keywordRankAsin, setKeywordRankAsin] = useState("ALL");
  const [keywordRankStatus, setKeywordRankStatus] = useState("ALL");
  const [keywordRankSort, setKeywordRankSort] = useState({ key: "priority", dir: "asc" });

  const applyAccounts = useCallback((body) => {
    const nextAccounts = (body.accounts || []).filter((account) => isAdmin || allowedAccountIds.has(String(account.id)));
    setAccounts(nextAccounts);
    if (nextAccounts.length > 0) {
      setSelectedAccountId((prev) => nextAccounts.some((account) => account.id === prev) ? prev : nextAccounts[0].id);
    } else {
      setSelectedAccountId(null);
    }
    setAccountsError(null);
    return nextAccounts;
  }, [allowedAccountIds, isAdmin]);

  const fetchAccounts = useCallback(() => {
    setAccountsLoading(true);
    setAccountsError(null);
    return refreshSharedReport({ action: "accounts" })
      .then(({ body }) => applyAccounts(body))
      .catch((err) => {
        setAccountsError(err.message);
        return [];
      })
      .finally(() => setAccountsLoading(false));
  }, [applyAccounts]);

  useEffect(() => {
    let active = true;
    setAccountsLoading(true);
    loadSharedReport({ action: "accounts" })
      .then(({ body }) => {
        if (!active) return;
        applyAccounts(body);
        if (body.snapshotMissing) setAccountsError(body.message);
      })
      .catch((error) => { if (active) setAccountsError(error.message); })
      .finally(() => { if (active) setAccountsLoading(false); });
    return () => { active = false; };
  }, [applyAccounts]);

  const accountById = useMemo(() => {
    const m = {};
    accounts.forEach((a) => (m[a.id] = a));
    return m;
  }, [accounts]);

  const selectedMarketplace = marketplaceProfile(
    accountById[selectedAccountId]?.country,
    accountById[selectedAccountId]?.currency
  );
  // All report windows follow the selected marketplace's business day. This
  // keeps a US, Canadian, Australian, Indian, or European account from being
  // queried for the wrong calendar date when the viewer is elsewhere.
  const TODAY = marketplaceToday(selectedMarketplace.country);

  const dashboardParams = useMemo(() => {
    if (!selectedAccountId) {
      return null;
    }
    // Bump this whenever the backend changes the metric definition so a
    // previously cached report can never be presented as the new one.
    return { action: "brand-sales", reportVersion: "brand-sales-shared-v1", ids: selectedAccountId, from: addDays(monthStart(TODAY), -420), to: TODAY };
  }, [selectedAccountId, TODAY]);

  // OLI data-quality (explicit-zero) params: the SAME wide account window + the selected brand (server-side Catalog
  // attribution). It is a read-only, ZERO-DataDoe Supabase read; the displayed count is scoped to the selected date
  // range CLIENT-side (mirrors scopedRows), so changing the date range never needs a re-fetch.
  const oliQualityParams = useMemo(() => {
    if (!selectedAccountId) return null;
    return { action: "oli-quality", ids: selectedAccountId, from: addDays(monthStart(TODAY), -420), to: TODAY, brand: selectedBrand || "ALL" };
  }, [selectedAccountId, TODAY, selectedBrand]);

  const portfolioAccountSignature = useMemo(() => {
    const discoveredIds = accounts.map((account) => String(account.id)).filter(Boolean);
    // Account permissions are already enforced server-side. This fallback lets
    // a permitted non-admin seed Brand View even when a fresh browser has not
    // yet received the shared account-directory snapshot.
    const ids = discoveredIds.length ? discoveredIds : (isAdmin ? [] : [...allowedAccountIds]);
    return [...new Set(ids)].sort().join(",");
  }, [accounts, allowedAccountIds, isAdmin]);
  // The self-healed server directory keys brandAccounts by the CANONICAL brand-key, so look it up by that key --
  // a case/whitespace variant of the selected brand resolves to the same (fresh) account set.
  const selectedBrandKey = selectedPortfolioBrand ? brandKey(selectedPortfolioBrand) : null;
  const portfolioMappingKnown = Boolean(
    selectedBrandKey && Array.isArray(brandDirectoryAccounts[selectedBrandKey])
  );
  const portfolioAccounts = useMemo(() => {
    if (!selectedBrandKey) return [];
    const mappedIds = brandDirectoryAccounts[selectedBrandKey];
    // A v1 directory has no account map. Discover the saved scope first;
    // never refresh every account merely because an older directory was read.
    if (!Array.isArray(mappedIds)) return [];
    const allowedIds = new Set(mappedIds.map(String));
    return accounts.filter((account) => allowedIds.has(String(account.id)));
  }, [accounts, brandDirectoryAccounts, selectedBrandKey]);
  const brandDirectoryCacheParams = useMemo(() => {
    if (portfolioAccountSignature) {
      return { action: "brand-directory", reportVersion: "brand-directory-shared-v2", ids: portfolioAccountSignature };
    }
    // Administrators may have no explicit account_permissions rows. Their
    // manual Brand View action lets the server discover connected accounts;
    // do not make this request automatically.
    return isAdmin ? { action: "brand-directory", reportVersion: "brand-directory-shared-v2" } : null;
  }, [isAdmin, portfolioAccountSignature]);

  const discoverSavedBrandAccounts = useCallback(async () => {
    const matchedIds = new Set();
    const rows = [];
    await Promise.all(accounts.map(async (account) => {
      const accountToday = marketplaceToday(account.country);
      const params = {
        action: "brand-sales", reportVersion: "brand-sales-shared-v1", ids: account.id,
        from: addDays(monthStart(accountToday), -420), to: accountToday,
      };
      try {
        const { body } = await loadSharedReport(params);
        (body.rows || []).forEach((row) => {
          if (brandKey(productBrand(row)) !== brandKey(selectedPortfolioBrand)) return;
          matchedIds.add(String(account.id));
          rows.push({ ...row, accountId: account.id, accountName: account.name, accountCountry: account.country, accountCurrency: account.currency });
        });
      } catch {
        // An unrelated account without a saved Dashboard snapshot is not an
        // error for this brand. It simply cannot prove this brand is present.
      }
    }));
    const matchedAccounts = accounts.filter((account) => matchedIds.has(String(account.id)));
    if (matchedAccounts.length) {
      // Seed the map under the CANONICAL key (matching the server directory), so the lookup finds it.
      setBrandDirectoryAccounts((current) => ({
        ...current,
        [brandKey(selectedPortfolioBrand)]: matchedAccounts.map((account) => String(account.id)),
      }));
    }
    return { accounts: matchedAccounts, rows };
  }, [accounts, selectedPortfolioBrand]);

  /* ===== Which accounts sell the selected portfolio brand =====
     The Brand Directory v2 map answers this directly. An older v1 directory has
     no account map, so the scope is discovered once from saved Supabase
     snapshots instead — never by refreshing every account. Resolving the account
     set is all DashboardApp does for the portfolio report; BrandPortfolio owns
     the report's own loading, refresh, currency and export. */
  const [discoveredBrandAccountIds, setDiscoveredBrandAccountIds] = useState(null);
  const [discoveringBrandAccounts, setDiscoveringBrandAccounts] = useState(false);

  useEffect(() => {
    setDiscoveredBrandAccountIds(null);
  }, [selectedPortfolioBrand]);

  useEffect(() => {
    if (dashboardMode !== "brand" || !selectedPortfolioBrand) return undefined;
    if (portfolioMappingKnown || discoveredBrandAccountIds !== null || discoveringBrandAccounts) return undefined;
    let active = true;
    setDiscoveringBrandAccounts(true);
    discoverSavedBrandAccounts()
      .then((discovered) => {
        if (active) setDiscoveredBrandAccountIds(discovered.accounts.map((account) => String(account.id)));
      })
      .catch(() => { if (active) setDiscoveredBrandAccountIds([]); })
      .finally(() => { if (active) setDiscoveringBrandAccounts(false); });
    return () => { active = false; };
  }, [dashboardMode, discoverSavedBrandAccounts, discoveredBrandAccountIds, discoveringBrandAccounts, portfolioMappingKnown, selectedPortfolioBrand]);

  const portfolioAccountIds = useMemo(() => (
    portfolioMappingKnown
      ? portfolioAccounts.map((account) => String(account.id))
      : (discoveredBrandAccountIds || [])
  ), [discoveredBrandAccountIds, portfolioAccounts, portfolioMappingKnown]);
  const portfolioSourceAccounts = useMemo(() => (
    portfolioAccountIds.map((accountId) => accountById[accountId]).filter(Boolean)
  ), [accountById, portfolioAccountIds]);
  const portfolioScopeResolved = portfolioMappingKnown || discoveredBrandAccountIds !== null;

  // The brand directory is READ-ONLY and self-healing: the server rebuilds it from the latest validated
  // brand-sales when the evidence changes, so re-reading it (on mount, focus, and the 60s interval) automatically
  // picks up a new scheduler brand-sales publication -- the selected brand's coverage updates with no manual
  // refresh and no DataDoe export. A request guard stops a slow read for a previous account scope from landing.
  const brandDirReqId = React.useRef(0);
  const reloadBrandDirectory = useCallback(async () => {
    if (dashboardMode !== "brand" || !brandDirectoryCacheParams || !portfolioAccountSignature) return;
    const myId = ++brandDirReqId.current;
    setBrandDirectoryLoading(true);
    try {
      const { body, cachedAt } = await loadSharedReport(brandDirectoryCacheParams);
      if (myId !== brandDirReqId.current) return;
      if (body.snapshotMissing && !(body.brands && body.brands.length)) {
        setBrandDirectoryBrands([]);
        setBrandDirectoryAccounts({});
        setBrandDirectoryFetchedAt(null);
        return;
      }
      setBrandDirectoryBrands(body.brands || []);
      setBrandDirectoryAccounts(body.brandAccounts || {});
      if (Array.isArray(body.accounts) && body.accounts.length) applyAccounts(body);
      setBrandDirectoryFetchedAt(new Date(cachedAt));
      setBrandDirectoryError(body.message || (body.partial ? "Some accounts have no saved catalog data yet. The available brands are loaded from shared report snapshots." : null));
      // A legacy v1 directory (no account map / no fingerprint) is upgraded by a plain re-READ: the server
      // self-heals it into the v2 map. This is Supabase-only and never creates a DataDoe export.
      if (body.snapshot?.legacyDirectory) {
        const { body: upgraded } = await loadSharedReport(brandDirectoryCacheParams);
        if (myId !== brandDirReqId.current || !upgraded.brands?.length) return;
        setBrandDirectoryBrands(upgraded.brands);
        setBrandDirectoryAccounts(upgraded.brandAccounts || {});
        if (Array.isArray(upgraded.accounts) && upgraded.accounts.length) applyAccounts(upgraded);
        setBrandDirectoryFetchedAt(new Date());
      }
    } catch (error) {
      if (myId === brandDirReqId.current) setBrandDirectoryError(error.message);
    } finally {
      if (myId === brandDirReqId.current) setBrandDirectoryLoading(false);
    }
  }, [applyAccounts, dashboardMode, brandDirectoryCacheParams, portfolioAccountSignature]);

  useEffect(() => { reloadBrandDirectory(); }, [reloadBrandDirectory]);
  useAutoRevalidate(reloadBrandDirectory, { active: dashboardMode === "brand" });

  const fetchBrandDirectory = useCallback(async () => {
    if (!brandDirectoryCacheParams || brandDirectoryLoading) return;
    setBrandDirectoryLoading(true);
    setBrandDirectoryError(null);
    setBrandDirectoryProgress({ completed: 0, total: Math.max(1, accounts.length || allowedAccountIds.size), account: "Product Catalog" });
    try {
      // The explicit directory action persists one Product Catalog result per
      // DataDoe organisation at a time. Continue the user-requested sync in
      // small serverless-safe batches; page load itself remains cache-only.
      let body;
      let batch = 0;
      let requestParams = brandDirectoryCacheParams;
      // One durable id for the whole explicit action, sent on EVERY request. The server
      // records it per attempted account so a replayed/tampered continuation cannot spend
      // a second DataDoe export for an account already attempted this action.
      const actionId = (globalThis.crypto?.randomUUID?.() || `act-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
      // The typed continuation cursor from the server: the accounts still to attempt in
      // THIS explicit action. It carries never-attempted AND previously-unavailable
      // accounts and only ever shrinks, so every eligible account is attempted exactly
      // once and the loop always terminates (never re-spins on one blocked account).
      let cursor = [];
      do {
        const continuation = batch > 0 ? { catalogSyncContinue: "1", catalogSyncAccountIds: cursor.join(",") } : {};
        ({ body } = await refreshSharedReport({ ...requestParams, catalogSyncActionId: actionId, ...continuation }));
        batch += 1;
        if (Array.isArray(body.accounts) && body.accounts.length) {
          requestParams = {
            ...brandDirectoryCacheParams,
            ids: body.accounts.map((account) => String(account.id)).filter(Boolean).sort().join(","),
          };
        }
        cursor = body.catalogSync?.remainingAccountIds || [];
        setBrandDirectoryProgress({
          completed: Math.max(0, (accounts.length || allowedAccountIds.size) - cursor.length),
          total: Math.max(1, accounts.length || allowedAccountIds.size),
          account: cursor.length ? `Loading ${cursor.length} remaining account${cursor.length === 1 ? "" : "s"}` : "Product Catalog",
        });
        // The server owns the queue: follow its remainingAccountIds only, and pass it back
        // verbatim as a consistency check (never reorder/inject/drop ids). Stop when the
        // server reports a typed operational-failure stop (never auto-retry it), when the
        // queue is empty, or at a hard safety cap. The cursor strictly shrinks, so it ends.
        if (body.catalogSync?.status === "operational-failure") break;
        if (!cursor.length || batch >= 200) break;
      } while (true);
      setBrandDirectoryBrands(body.brands || []);
      setBrandDirectoryAccounts(body.brandAccounts || {});
      if (Array.isArray(body.accounts) && body.accounts.length) applyAccounts(body);
      setBrandDirectoryVersion((version) => version + 1);
      setBrandDirectoryFetchedAt(new Date());
      const unavailable = body.catalogUnavailableAccounts || [];
      if (unavailable.length) {
        // Admin-safe: summarise ONLY the typed codes the server returned. A raw DataDoe
        // response body, source id, URL or status object is never shown.
        const total = unavailable.length;
        const allSourceUnavailable = unavailable.every((account) => account.code === "PRODUCT_CATALOG_SOURCE_UNAVAILABLE");
        const lead = allSourceUnavailable
          ? `Product Catalog source is unavailable for ${total} primary account${total === 1 ? "" : "s"}.`
          : `Product Catalog is unavailable for ${total} primary account${total === 1 ? "" : "s"}.`;
        setBrandDirectoryError(`${lead} This is an upstream DataDoe primary-organization source-access or configuration issue; brands already saved for other accounts are preserved and still shown.`);
      } else if (body.message || body.partial) {
        setBrandDirectoryError(body.message || "Some account catalogs are still pending. Keep this page open while the directory sync completes.");
      }
      setBrandDirectoryProgress({ completed: 1, total: 1, account: "Product Catalog" });
      if (!(body.brands || []).length) setBrandDirectoryError("No named brands were returned from the accessible Product Catalog. Refresh the account directory and confirm that your DataDoe catalog source is enabled.");
    } catch (error) {
      setBrandDirectoryError(error.message);
    } finally {
      setBrandDirectoryLoading(false);
      setBrandDirectoryProgress(null);
    }
  }, [accounts.length, allowedAccountIds.size, applyAccounts, brandDirectoryCacheParams, brandDirectoryLoading]);

  // Per-report request guard: a slow response for a previous account/brand/date scope must never overwrite the
  // current one (no cross-account leak, no stale flash). Each loader bumps its id on entry and applies a response
  // only while that id is still the newest for its report. One ref keyed by report avoids seven separate refs.
  const reqIds = React.useRef({});
  const bumpReq = useCallback((k) => { reqIds.current[k] = (reqIds.current[k] || 0) + 1; return reqIds.current[k]; }, []);
  const isCurrentReq = useCallback((k, id) => reqIds.current[k] === id, []);

  const loadCachedRows = useCallback(async () => {
    if (!dashboardParams) {
      bumpReq("dashboard");
      setRows([]);
      setRowsLoading(false);
      return;
    }
    const myId = bumpReq("dashboard");
    setRowsLoading(true);
    const cached = await readLargeApiCache(dashboardParams);
    if (!isCurrentReq("dashboard", myId)) return;
    if (cached) {
      setRows(cached.body.rows || []);
      setCatalogBrands(cached.body.catalogBrands || []);
      setCatalogBrandsAccountId(selectedAccountId);
      setLastFetchedAt(new Date(cached.cachedAt));
      setRowsError(null);
      setRowsCacheMissing(false);
      setSalesCompleteness(cached.body.completeness || null);
    } else {
      setRows([]);
      setCatalogBrands([]);
      setCatalogBrandsAccountId(null);
      setLastFetchedAt(null);
      setRowsError(null);
      setRowsCacheMissing(true);
    }
    try {
      const { body, cachedAt } = await loadSharedReport(dashboardParams);
      if (!isCurrentReq("dashboard", myId)) return;
      setRows(body.rows || []);
      setCatalogBrands(body.catalogBrands || []);
      setCatalogBrandsAccountId(selectedAccountId);
      setLastFetchedAt(new Date(cachedAt));
      setRowsError(null);
      setRowsCacheMissing(Boolean(body.snapshotMissing));
      setSalesCompleteness(body.completeness || null);
    } catch (error) {
      if (!isCurrentReq("dashboard", myId)) return;
      if (!cached) setRowsError(error.message);
    } finally {
      if (isCurrentReq("dashboard", myId)) setRowsLoading(false);
    }
  }, [dashboardParams, bumpReq, isCurrentReq, selectedAccountId]);

  // OLI data-quality (explicit-zero) -- read-only, ZERO-DataDoe. A failed read PRESERVES the previous quality state
  // (last-known-good) and never disturbs the business rows; `available:false` renders a non-destructive
  // "quality details unavailable" state.
  const [oliQuality, setOliQuality] = useState(null);
  const loadOliQuality = useCallback(async () => {
    if (!oliQualityParams) { setOliQuality(null); return; }
    const myId = bumpReq("oli-quality");
    try {
      const { body } = await loadSharedReport(oliQualityParams);
      if (!isCurrentReq("oli-quality", myId)) return;
      setOliQuality(body && typeof body === "object" ? body : { available: false });
    } catch (_e) {
      if (isCurrentReq("oli-quality", myId)) setOliQuality((prev) => (prev && prev.available ? prev : { available: false }));
    }
  }, [oliQualityParams, bumpReq, isCurrentReq]);

  const fetchRows = useCallback(() => {
    if (!dashboardParams) {
      setRows([]);
      setRowsError(accounts.length === 0 ? "No cached accounts yet. Click refresh to fetch accounts first." : null);
      return;
    }
    // In-flight guard: a second click must never start a duplicate DataDoe
    // export for the same scope.
    if (rowsLoading) return;
    setRowsLoading(true);
    setRowsError(null);
    refreshSharedReport(dashboardParams)
      .then(({ body, cachedAt }) => {
        setRows(body.rows || []);
        setCatalogBrands(body.catalogBrands || []);
        setCatalogBrandsAccountId(selectedAccountId);
        setLastFetchedAt(new Date(cachedAt));
        setRowsCacheMissing(false);
        setSalesCompleteness(body.completeness || null);
      })
      .catch((err) => setRowsError(err.message))
      .finally(() => setRowsLoading(false));
  }, [accounts.length, dashboardParams, rowsLoading]);

  useEffect(() => {
    loadCachedRows();
  }, [loadCachedRows]);
  useAutoRevalidate(loadCachedRows, { active: view === "dashboard" && dashboardMode === "account" });

  // The quality indicator shares the dashboard's revalidation triggers (page load, account/brand change, focus,
  // visibility, the 60s interval) so it stays in step with the business rows -- without ever spending a token.
  useEffect(() => { loadOliQuality(); }, [loadOliQuality]);
  useAutoRevalidate(loadOliQuality, { active: view === "dashboard" && dashboardMode === "account" });

  useEffect(() => { setSelectedBrand("ALL"); }, [selectedAccountId]);

  // Daily Reporting fetch: pull ~5 months of single-account history so the
  // report can show 3 completed months + current-month MTD + the last 5 days.
  const dailyParams = useMemo(() => {
    if (!selectedAccountId) return null;
    const mb = monthBack(TODAY, 5);
    return { action: "daily", reportVersion: "daily-reporting-shared-v2", ids: selectedAccountId, brand: selectedBrand, from: mb.from, to: TODAY };
  }, [selectedAccountId, selectedBrand, TODAY]);

  const loadCachedDaily = useCallback(async () => {
    if (!dailyParams) {
      bumpReq("daily");
      setDailyRows([]);
      setDailyLoading(false);
      return;
    }
    const myId = bumpReq("daily");
    // No cached copy yet => first paint shows a skeleton (dailyLoading); a revalidation with rows already shown
    // keeps them visible and flips the header to a compact "Updating…" instead of clearing the report.
    setDailyLoading(true);
    const cached = await readLargeApiCache(dailyParams);
    if (!isCurrentReq("daily", myId)) return;
    if (cached) {
      setDailyRows(cached.body.rows || []);
      setLastFetchedAt(new Date(cached.cachedAt));
      setDailyError(null);
      setDailyCompleteness(cached.body.completeness || null);
    } else {
      setDailyRows([]);
      setDailyError(null);
    }
    try {
      const { body, cachedAt } = await loadSharedReport(dailyParams);
      if (!isCurrentReq("daily", myId)) return;
      setDailyRows(body.rows || []);
      setLastFetchedAt(new Date(cachedAt));
      setDailyError(body.snapshotMissing ? body.message : null);
      setDailyMissing(Boolean(body.snapshotMissing));
      setDailyCompleteness(body.completeness || null);
    } catch (error) {
      if (!isCurrentReq("daily", myId)) return;
      if (!cached) { setDailyError(error.message); setDailyMissing(false); }
    } finally {
      if (isCurrentReq("daily", myId)) setDailyLoading(false);
    }
  }, [dailyParams, bumpReq, isCurrentReq]);

  const fetchDaily = useCallback(() => {
    if (!dailyParams || dailyLoading) return;
    setDailyLoading(true);
    setDailyError(null);
    setDailyMissing(false);
    refreshSharedReport(dailyParams)
      .then(({ body, cachedAt }) => {
        setDailyRows(body.rows || []);
        setLastFetchedAt(new Date(cachedAt));
      })
      .catch((err) => { setDailyError(err.message); setDailyMissing(false); })
      .finally(() => setDailyLoading(false));
  }, [dailyParams, dailyLoading]);

  useEffect(() => {
    if (view === "daily") loadCachedDaily();
  }, [view, loadCachedDaily]);
  useAutoRevalidate(loadCachedDaily, { active: view === "daily" });

  // FBA Shipment Plan: cache-first, single selected account, manual refresh only.
  const planParams = useMemo(() => {
    if (!selectedAccountId) return null;
    // Bump reportVersion if the backend metric definition changes so a stale
    // cached report can never be presented as the current one. `to` (the as-of
    // date) is part of the cache key; the target-coverage input is NOT, because
    // it is applied locally and must never trigger a refetch.
    return { action: "fba-plan", reportVersion: "fba-plan-shared-v1", ids: selectedAccountId, to: TODAY };
  }, [selectedAccountId, TODAY]);

  const loadCachedPlan = useCallback(async () => {
    if (!planParams) {
      bumpReq("fbaplan");
      setPlanData(null);
      return;
    }
    const myId = bumpReq("fbaplan");
    const cached = await readLargeApiCache(planParams);
    if (!isCurrentReq("fbaplan", myId)) return;
    if (cached) {
      setPlanData(cached.body);
      setPlanCachedAt(new Date(cached.cachedAt));
      setPlanError(null);
      setSnapshotNotice(null);
    } else {
      setPlanData(null);
      setPlanCachedAt(null);
      setPlanError(null);
      setSnapshotNotice("No saved FBA Shipment Plan for this account yet — waiting for the scheduled data refresh.");
    }
    try {
      const { body, cachedAt } = await loadSharedReport(planParams);
      if (!isCurrentReq("fbaplan", myId)) return;
      if (body.snapshotMissing) {
        setPlanData(null);
        setPlanCachedAt(null);
        setSnapshotNotice(body.message);
      } else {
        setPlanData(body);
        setPlanCachedAt(new Date(cachedAt));
        setPlanError(null);
        setSnapshotNotice(null);
      }
    } catch (error) {
      if (!isCurrentReq("fbaplan", myId)) return;
      if (!cached) setPlanError(error.message);
    }
  }, [planParams, bumpReq, isCurrentReq]);

  const fetchPlan = useCallback(() => {
    if (!planParams || planLoading) return;
    setPlanLoading(true);
    setPlanError(null);
    refreshSharedReport(planParams)
      .then(({ body, cachedAt }) => {
        setPlanData(body);
        setPlanCachedAt(new Date(cachedAt));
      })
      .catch((err) => setPlanError(err.message))
      .finally(() => setPlanLoading(false));
  }, [planParams, planLoading]);

  useEffect(() => {
    if (view === "fbaplan") loadCachedPlan();
  }, [view, loadCachedPlan]);
  useAutoRevalidate(loadCachedPlan, { active: view === "fbaplan" });

  // Load the durable planning config for the selected account (read-only; never DataDoe). Resets on account change so
  // one account's settings/warehouse never leak into another.
  const loadPlanConfig = useCallback(async () => {
    if (!selectedAccountId || !session?.access_token) { setPlanConfig(null); return; }
    const acct = selectedAccountId;
    try {
      const cfg = await authFetch(`/api/fba-plan-config?accountId=${encodeURIComponent(acct)}`, session.access_token);
      if (selectedAccountId === acct) setPlanConfig(cfg && typeof cfg === "object" ? cfg : { settings: null, overrides: [], warehouse: [] });
    } catch (_e) {
      if (selectedAccountId === acct) setPlanConfig({ settings: null, overrides: [], warehouse: [] });
    }
  }, [selectedAccountId, session?.access_token]);
  useEffect(() => { if (view === "fbaplan") loadPlanConfig(); else setPlanConfig(null); }, [view, loadPlanConfig]);

  // The resolved ACCOUNT-DEFAULT planning settings (durable, with the system defaults when unsaved).
  const planAccountSettings = useMemo(() => {
    const s = planConfig?.settings || null;
    const horizon = normalizeHorizon(
      s ? (s.horizon_kind === "days" ? { kind: "days", days: s.horizon_days } : { kind: "months", months: s.horizon_months }) : null
    ) || { ...SYSTEM_DEFAULT_HORIZON };
    return {
      horizon,
      forecastMethod: s?.forecast_method || DEFAULT_FORECAST_METHOD,
      forecastWeights: Array.isArray(s?.forecast_weights) ? s.forecast_weights.map(Number) : null,
      safetyDays: Number.isFinite(Number(s?.safety_days)) ? Number(s.safety_days) : DEFAULT_SAFETY_DAYS,
      isSaved: !!s,
    };
  }, [planConfig]);

  // SKU horizon overrides + seller warehouse qty, keyed for O(1) lookup during the per-row planning compute.
  const planSkuOverrides = useMemo(() => {
    const m = new Map();
    for (const o of planConfig?.overrides || []) m.set(String(o.sku), o.horizon_kind === "days" ? { kind: "days", days: o.horizon_days } : { kind: "months", months: o.horizon_months });
    return m;
  }, [planConfig]);
  const planWarehouseBySku = useMemo(() => {
    const m = new Map();
    for (const w of planConfig?.warehouse || []) m.set(String(w.sku), { qty: Number(w.qty), marketplace: w.marketplace, childAsin: w.child_asin || "", note: w.note || "", updatedByEmail: w.updated_by_email || "" });
    return m;
  }, [planConfig]);

  // Org-wide Product Catalog ASIN -> { brand, productName }, for enriching manual/warehouse SKUs + proving an ASIN
  // exists during import. Present on v2d-5+ snapshots.
  const planCatalogByAsin = useMemo(() => (planData && planData.catalogByAsin && typeof planData.catalogByAsin === "object" ? planData.catalogByAsin : {}), [planData]);
  const planCatalogAsins = useMemo(() => new Set(Object.keys(planCatalogByAsin)), [planCatalogByAsin]);

  // The client SKU DIRECTORY: the account-scoped directory from the snapshot (each entry keeps its childAsin / brand /
  // productName / marketplace / provenance) UNION already-saved warehouse SKUs (enriched from the catalog map). Keyed
  // by SKU. Backward compatible: an older snapshot with only the string `accountSkus` yields identity-less entries.
  const planSkuDirectory = useMemo(() => {
    const m = new Map();
    const dir = Array.isArray(planData?.accountSkuDirectory) ? planData.accountSkuDirectory : null;
    if (dir) {
      for (const e of dir) if (e && e.sku) m.set(String(e.sku), { ...e, sku: String(e.sku) });
    } else {
      for (const sku of Array.isArray(planData?.accountSkus) ? planData.accountSkus : []) if (sku) m.set(String(sku), { sku: String(sku), childAsin: null, brand: null, productName: null, marketplace: planData?.marketCountry || null, provenance: "source" });
    }
    // Warehouse-saved SKUs the directory does not already carry (manual): enrich from the catalog + the warehouse row.
    for (const [sku, wh] of planWarehouseBySku) {
      const key = String(sku);
      if (m.has(key)) continue;
      const asin = wh.childAsin || null;
      const cat = asin ? planCatalogByAsin[asin] : null;
      m.set(key, { sku: key, childAsin: asin, brand: cat?.brand || null, productName: cat?.productName || null, marketplace: wh.marketplace || planData?.marketCountry || null, provenance: "manual" });
    }
    return m;
  }, [planData, planWarehouseBySku, planCatalogByAsin]);

  // Legacy authorization set (SKU strings) kept for the import fallback when no directory is present.
  const planKnownSkus = useMemo(() => new Set(planSkuDirectory.keys()), [planSkuDirectory]);

  // Persist the account planning settings, then reload the config (recomputes the plan locally, zero DataDoe).
  const savePlanSettings = useCallback(async (patch) => {
    if (!selectedAccountId || !session?.access_token) return;
    const cur = planAccountSettings;
    const horizon = patch.horizon || cur.horizon;
    const body = {
      kind: "settings", accountId: selectedAccountId,
      horizonKind: horizon.kind, horizonMonths: horizon.kind === "months" ? horizon.months : undefined, horizonDays: horizon.kind === "days" ? horizon.days : undefined,
      forecastMethod: patch.forecastMethod || cur.forecastMethod,
      forecastWeights: (patch.forecastMethod || cur.forecastMethod) === "weighted" ? (patch.forecastWeights || cur.forecastWeights) : undefined,
      safetyDays: patch.safetyDays != null ? patch.safetyDays : cur.safetyDays,
    };
    setPlanConfigBusy(true);
    try { await authFetch("/api/fba-plan-config", session.access_token, { method: "POST", body: JSON.stringify(body) }); await loadPlanConfig(); }
    catch (e) { setPlanError(String(e && e.message ? e.message : e)); }
    finally { setPlanConfigBusy(false); }
  }, [selectedAccountId, session?.access_token, planAccountSettings, loadPlanConfig]);

  // Persist one seller-warehouse quantity (qty=null clears it), then reload + recompute.
  const saveWarehouseQty = useCallback(async ({ sku, marketplace, childAsin, qty, note }) => {
    if (!selectedAccountId || !session?.access_token || !sku || !marketplace) return;
    setPlanConfigBusy(true);
    try {
      await authFetch("/api/fba-plan-config", session.access_token, {
        method: "POST",
        body: JSON.stringify({ kind: "warehouse", accountId: selectedAccountId, sku, marketplace, childAsin: childAsin || "", qty: qty == null ? undefined : qty, clear: qty == null, note: note || "" }),
      });
      await loadPlanConfig();
    } catch (e) { setPlanError(String(e && e.message ? e.message : e)); }
    finally { setPlanConfigBusy(false); }
  }, [selectedAccountId, session?.access_token, loadPlanConfig]);

  // Persist (or clear) ONE SKU's horizon override, then reload + recompute. clear=true reverts the SKU to the
  // account default ("inherit").
  const saveSkuHorizon = useCallback(async ({ sku, horizon, clear }) => {
    if (!selectedAccountId || !session?.access_token || !sku) return;
    const body = clear
      ? { kind: "sku-horizon", accountId: selectedAccountId, sku, clear: true }
      : { kind: "sku-horizon", accountId: selectedAccountId, sku, horizonKind: horizon.kind, horizonMonths: horizon.kind === "months" ? horizon.months : undefined, horizonDays: horizon.kind === "days" ? horizon.days : undefined };
    setPlanConfigBusy(true);
    try { await authFetch("/api/fba-plan-config", session.access_token, { method: "POST", body: JSON.stringify(body) }); await loadPlanConfig(); setSkuHorizonEdit(null); }
    catch (e) { setPlanError(String(e && e.message ? e.message : e)); }
    finally { setPlanConfigBusy(false); }
  }, [selectedAccountId, session?.access_token, loadPlanConfig]);

  // Atomic bulk seller-warehouse apply (validated + de-duplicated client rows). Returns the applied count or throws.
  const bulkImportWarehouse = useCallback(async (rows) => {
    if (!selectedAccountId || !session?.access_token) throw new Error("No account selected.");
    const res = await authFetch("/api/fba-plan-config", session.access_token, {
      method: "POST", body: JSON.stringify({ kind: "warehouse-bulk", accountId: selectedAccountId, rows }),
    });
    await loadPlanConfig();
    return res;
  }, [selectedAccountId, session?.access_token, loadPlanConfig]);

  // Per-USER column-visibility prefs: localStorage for an instant first paint, then the durable server copy (which
  // wins). Saving writes both. A guest (no session) keeps localStorage only.
  const columnPrefsKey = useMemo(() => `fbaplan.cols.${session?.user?.id || "anon"}`, [session?.user?.id]);
  const loadPlanColumns = useCallback(async () => {
    let local = null;
    try { const raw = localStorage.getItem(columnPrefsKey); if (raw) local = JSON.parse(raw); } catch { /* ignore */ }
    // No saved preference anywhere yet -> the default view (raw component columns hidden).
    if (Array.isArray(local)) setPlanHiddenCols(new Set(local.map(String)));
    else setPlanHiddenCols(new Set(PLAN_DEFAULT_HIDDEN_COLS));
    if (!session?.access_token) return;
    try {
      const r = await authFetch("/api/fba-plan-columns", session.access_token);
      // A SAVED preference (updatedAt present) wins -- even an empty set (the user chose "Select all"). Only when the
      // user has never saved AND there is no local copy do we fall back to the default view.
      if (r && r.updatedAt) setPlanHiddenCols(new Set((r.hiddenColumns || []).map(String)));
      else if (!Array.isArray(local)) setPlanHiddenCols(new Set(PLAN_DEFAULT_HIDDEN_COLS));
    } catch { /* keep local */ }
  }, [columnPrefsKey, session?.access_token]);
  useEffect(() => { if (view === "fbaplan") loadPlanColumns(); }, [view, loadPlanColumns]);
  const savePlanColumns = useCallback(async (nextHidden) => {
    const arr = Array.from(nextHidden);
    setPlanHiddenCols(new Set(arr));
    try { localStorage.setItem(columnPrefsKey, JSON.stringify(arr)); } catch { /* ignore */ }
    if (!session?.access_token) return;
    setPlanColsBusy(true);
    try { await authFetch("/api/fba-plan-columns", session.access_token, { method: "POST", body: JSON.stringify({ hiddenColumns: arr }) }); }
    catch { /* localStorage already holds it */ }
    finally { setPlanColsBusy(false); }
  }, [columnPrefsKey, session?.access_token]);

  // SKU Movement per-USER prefs (window N + hidden columns). localStorage gives an instant first paint; the durable
  // server copy (user-scoped) wins. Kept SEPARATE from the report snapshot so a zero-export re-derive never erases it.
  const skuPrefsKey = useMemo(() => `skumv.prefs.${session?.user?.id || "anon"}`, [session?.user?.id]);
  const loadSkuPrefs = useCallback(async () => {
    try { const raw = localStorage.getItem(skuPrefsKey); if (raw) { const p = JSON.parse(raw); if (p && typeof p === "object") { if (p.recentDays != null) setSkuRecentDays(clampRecentDays(p.recentDays)); if (Array.isArray(p.hiddenColumns)) setSkuHiddenCols(p.hiddenColumns.map(String)); } } } catch { /* ignore */ }
    if (!session?.access_token) return;
    try {
      const r = await authFetch("/api/sku-movement-prefs", session.access_token);
      if (r) { setSkuRecentDays(clampRecentDays(r.recentDays)); setSkuHiddenCols((r.hiddenColumns || []).map(String)); }
    } catch { /* keep local */ }
  }, [skuPrefsKey, session?.access_token]);
  useEffect(() => { if (view === "skumovement") loadSkuPrefs(); }, [view, loadSkuPrefs]);
  const persistSkuPrefs = useCallback(async (patch) => {
    // Optimistic local write so the UI reacts instantly; the server copy is the durable source of truth.
    const next = { recentDays: patch.recentDays != null ? clampRecentDays(patch.recentDays) : skuRecentDays, hiddenColumns: patch.hiddenColumns != null ? patch.hiddenColumns.map(String) : skuHiddenCols };
    if (patch.recentDays != null) setSkuRecentDays(next.recentDays);
    if (patch.hiddenColumns != null) setSkuHiddenCols(next.hiddenColumns);
    try { localStorage.setItem(skuPrefsKey, JSON.stringify(next)); } catch { /* ignore */ }
    if (!session?.access_token) return;
    try { await authFetch("/api/sku-movement-prefs", session.access_token, { method: "POST", body: JSON.stringify(patch) }); }
    catch { /* localStorage already holds it */ }
  }, [skuPrefsKey, session?.access_token, skuRecentDays, skuHiddenCols]);
  const onSkuRecentDaysChange = useCallback((n) => persistSkuPrefs({ recentDays: clampRecentDays(n) }), [persistSkuPrefs]);
  const onSkuColumnsChange = useCallback((cols) => persistSkuPrefs({ hiddenColumns: Array.isArray(cols) ? cols : [] }), [persistSkuPrefs]);

  // Manual per-(account, ASIN) Identifier writes. The server derives marketplace + org fingerprint and re-validates
  // ownership + ASIN membership; a successful write re-reads the durable snapshot (identifiers join at serve).
  const onSaveIdentifier = useCallback(async (childAsin, identifier) => {
    if (!selectedAccountId || !session?.access_token || !childAsin) return;
    setSkuIdentBusy(true);
    try {
      await authFetch("/api/sku-movement-identifier", session.access_token, { method: "POST", body: JSON.stringify({ kind: "set", accountId: selectedAccountId, childAsin, identifier: identifier || "" }) });
      if (skuReloadRef.current) await skuReloadRef.current();
    } finally { setSkuIdentBusy(false); }
  }, [selectedAccountId, session?.access_token]);
  const onBulkIdentifiers = useCallback(async (rows) => {
    if (!selectedAccountId || !session?.access_token) throw new Error("No account selected.");
    setSkuIdentBusy(true);
    try {
      const res = await authFetch("/api/sku-movement-identifier", session.access_token, { method: "POST", body: JSON.stringify({ kind: "bulk", accountId: selectedAccountId, rows }) });
      if (skuReloadRef.current) await skuReloadRef.current();
      return res;
    } finally { setSkuIdentBusy(false); }
  }, [selectedAccountId, session?.access_token]);

  const reconciliationWindow = useMemo(() => sixFullCalendarMonths(TODAY), [TODAY]);
  const reconciliationParams = useMemo(() => {
    if (!selectedAccountId) return null;
    return {
      action: "reconciliation", reportVersion: "reconciliation-shared-v1", ids: selectedAccountId,
      from: reconciliationWindow.from, to: reconciliationWindow.to,
    };
  }, [selectedAccountId, reconciliationWindow]);

  const applyReconciliationData = useCallback((body, cachedAt) => {
    setReconciliationData(body);
    setReconciliationCachedAt(new Date(cachedAt));
    setReconciliationMonth((previous) => body.months?.includes(previous) ? previous : body.months?.[body.months.length - 1] || "");
    setReconciliationError(null);
  }, []);

  const loadCachedReconciliation = useCallback(async () => {
    if (!reconciliationParams) {
      bumpReq("reconciliation");
      setReconciliationData(null);
      return;
    }
    const myId = bumpReq("reconciliation");
    const cached = await readLargeApiCache(reconciliationParams);
    if (!isCurrentReq("reconciliation", myId)) return;
    if (cached) { setSnapshotNotice(null); applyReconciliationData(cached.body, cached.cachedAt); }
    else {
      setReconciliationData(null);
      setReconciliationCachedAt(null);
      setReconciliationError(null);
      setSnapshotNotice("No saved reconciliation for this account yet — waiting for the scheduled data refresh.");
    }
    try {
      const { body, cachedAt } = await loadSharedReport(reconciliationParams);
      if (!isCurrentReq("reconciliation", myId)) return;
      if (body.snapshotMissing) {
        setReconciliationData(null);
        setReconciliationCachedAt(null);
        setSnapshotNotice(body.message);
      } else {
        setSnapshotNotice(null);
        applyReconciliationData(body, cachedAt);
      }
    } catch (error) {
      if (!isCurrentReq("reconciliation", myId)) return;
      if (!cached) setReconciliationError(error.message);
    }
  }, [applyReconciliationData, reconciliationParams, bumpReq, isCurrentReq]);

  const fetchReconciliation = useCallback(() => {
    if (!reconciliationParams || reconciliationLoading) return;
    setReconciliationLoading(true);
    setReconciliationError(null);
    refreshSharedReport(reconciliationParams)
      .then(({ body, cachedAt }) => applyReconciliationData(body, cachedAt))
      .catch((err) => setReconciliationError(err.message))
      .finally(() => setReconciliationLoading(false));
  }, [applyReconciliationData, reconciliationLoading, reconciliationParams]);

  useEffect(() => {
    if (view === "reconciliation") loadCachedReconciliation();
  }, [view, loadCachedReconciliation]);
  useAutoRevalidate(loadCachedReconciliation, { active: view === "reconciliation" });

  // SKU P&L Analyzer: six full calendar months, cache-first, shared header scope.
  const skuPlWindow = useMemo(() => sixFullCalendarMonths(TODAY), [TODAY]);
  const skuPlParams = useMemo(() => {
    if (!selectedAccountId) return null;
    return {
      action: "sku-pl", reportVersion: "sku-pl-shared-v1", ids: selectedAccountId,
      from: skuPlWindow.from, to: skuPlWindow.to,
    };
  }, [selectedAccountId, skuPlWindow]);

  const applySkuPlData = useCallback((body, cachedAt, accountCurrency) => {
    setSkuPlData(body);
    setSkuPlCachedAt(new Date(cachedAt));
    // Populate the shared header selector even when this account has not had a
    // dashboard refresh yet. These are only brands present in the P&L scope;
    // any fuller catalog cache remains merged by `brandList`.
    if (body.accountId && Array.isArray(body.catalogBrands)) {
      setCatalogBrands(body.catalogBrands);
      setCatalogBrandsAccountId(body.accountId);
    }
    // Default to the latest completed month; keep the prior choice if still valid.
    setSkuPlMonth((prev) => (body.months?.includes(prev) || prev === "ALL") ? prev : body.months?.[body.months.length - 1] || "ALL");
    // Default currency: the account's own currency if present, else the first.
    const currencies = body.currencies || [];
    setSkuPlCurrency((prev) => currencies.includes(prev) ? prev : (currencies.includes(accountCurrency) ? accountCurrency : currencies[0] || ""));
    setSkuPlPage(1);
    setSkuPlError(null);
  }, []);

  const loadCachedSkuPl = useCallback(async () => {
    if (!skuPlParams) { bumpReq("skupl"); setSkuPlData(null); return; }
    const myId = bumpReq("skupl");
    const cached = await readLargeApiCache(skuPlParams);
    if (!isCurrentReq("skupl", myId)) return;
    if (cached) { setSnapshotNotice(null); applySkuPlData(cached.body, cached.cachedAt, accountById[selectedAccountId]?.currency); }
    else {
      setSkuPlData(null);
      setSkuPlCachedAt(null);
      setSkuPlError(null);
      setSnapshotNotice("No saved SKU P&L for this account yet — waiting for the scheduled data refresh.");
    }
    try {
      const { body, cachedAt } = await loadSharedReport(skuPlParams);
      if (!isCurrentReq("skupl", myId)) return;
      if (body.snapshotMissing) {
        setSkuPlData(null);
        setSkuPlCachedAt(null);
        setSnapshotNotice(body.message);
      } else {
        setSnapshotNotice(null);
        applySkuPlData(body, cachedAt, accountById[selectedAccountId]?.currency);
      }
    } catch (error) {
      if (!isCurrentReq("skupl", myId)) return;
      if (!cached) setSkuPlError(error.message);
    }
  }, [applySkuPlData, skuPlParams, accountById, selectedAccountId, bumpReq, isCurrentReq]);

  const fetchSkuPl = useCallback(() => {
    if (!skuPlParams || skuPlLoading) return;
    setSkuPlLoading(true);
    setSkuPlError(null);
    refreshSharedReport(skuPlParams)
      .then(({ body, cachedAt }) => applySkuPlData(body, cachedAt, accountById[selectedAccountId]?.currency))
      .catch((err) => setSkuPlError(err.message))
      .finally(() => setSkuPlLoading(false));
  }, [applySkuPlData, skuPlLoading, skuPlParams, accountById, selectedAccountId]);

  useEffect(() => {
    if (view === "skupl") loadCachedSkuPl();
  }, [view, loadCachedSkuPl]);
  useAutoRevalidate(loadCachedSkuPl, { active: view === "skupl" });

  // Reset paging when any SKU P&L filter/scope changes (all local, no refetch).
  useEffect(() => { setSkuPlPage(1); }, [skuPlMonth, skuPlCurrency, skuPlSearch, skuPlStatusFilter, selectedBrand]);

  const contentChangesParams = useMemo(() => {
    if (!selectedAccountId) return null;
    return {
      action: "content-changes", reportVersion: "content-changes-shared-v1", ids: selectedAccountId, asOf: TODAY,
    };
  }, [selectedAccountId, TODAY]);

  const applyContentChangesData = useCallback((body, cachedAt) => {
    setContentChangesData(body);
    setContentChangesCachedAt(new Date(cachedAt));
    if (body.accountId && Array.isArray(body.catalogBrands)) {
      setCatalogBrands(body.catalogBrands);
      setCatalogBrandsAccountId(body.accountId);
    }
    setContentChangesError(null);
  }, []);

  const loadCachedContentChanges = useCallback(async () => {
    if (!contentChangesParams) { bumpReq("contentchanges"); setContentChangesData(null); return; }
    const myId = bumpReq("contentchanges");
    const cached = await readLargeApiCache(contentChangesParams);
    if (!isCurrentReq("contentchanges", myId)) return;
    if (cached) { setSnapshotNotice(null); applyContentChangesData(cached.body, cached.cachedAt); }
    else {
      setContentChangesData(null);
      setContentChangesCachedAt(null);
      setContentChangesError(null);
      setSnapshotNotice("No saved content alerts for this account yet — waiting for the scheduled data refresh.");
    }
    try {
      const { body, cachedAt } = await loadSharedReport(contentChangesParams);
      if (!isCurrentReq("contentchanges", myId)) return;
      if (body.snapshotMissing) {
        setContentChangesData(null);
        setContentChangesCachedAt(null);
        setSnapshotNotice(body.message);
      } else {
        setSnapshotNotice(null);
        applyContentChangesData(body, cachedAt);
      }
    } catch (error) {
      if (!isCurrentReq("contentchanges", myId)) return;
      if (!cached) setContentChangesError(error.message);
    }
  }, [applyContentChangesData, contentChangesParams, bumpReq, isCurrentReq]);

  const fetchContentChanges = useCallback(() => {
    if (!contentChangesParams || contentChangesLoading) return;
    setContentChangesLoading(true);
    setContentChangesError(null);
    refreshSharedReport(contentChangesParams)
      .then(({ body, cachedAt }) => applyContentChangesData(body, cachedAt))
      .catch((err) => setContentChangesError(err.message))
      .finally(() => setContentChangesLoading(false));
  }, [applyContentChangesData, contentChangesLoading, contentChangesParams]);

  useEffect(() => {
    if (view === "contentchanges") loadCachedContentChanges();
  }, [view, loadCachedContentChanges]);
  useAutoRevalidate(loadCachedContentChanges, { active: view === "contentchanges" });

  // Keyword Rank & Share Tracker: SQP data is large enough to use IndexedDB
  // when available. Loading a cached account snapshot, changing brand, or
  // filtering never calls DataDoe; only the shared header Refresh does.
  const keywordRankParams = useMemo(() => {
    if (!selectedAccountId) return null;
    return {
      action: "keyword-rank", reportVersion: "keyword-rank-shared-v1", ids: selectedAccountId, to: TODAY,
    };
  }, [selectedAccountId, TODAY]);

  const applyKeywordRankData = useCallback((body, cachedAt) => {
    setKeywordRankData(body);
    setKeywordRankCachedAt(new Date(cachedAt));
    if (body.accountId && Array.isArray(body.catalogBrands)) {
      setCatalogBrands(body.catalogBrands);
      setCatalogBrandsAccountId(body.accountId);
    }
    setKeywordRankAsin("ALL");
    setKeywordRankError(null);
  }, []);

  const loadCachedKeywordRank = useCallback(async () => {
    if (!keywordRankParams) { bumpReq("keywordrank"); setKeywordRankData(null); return; }
    const myId = bumpReq("keywordrank");
    const cached = await readLargeApiCache(keywordRankParams);
    if (!isCurrentReq("keywordrank", myId)) return;
    if (cached) { setSnapshotNotice(null); applyKeywordRankData(cached.body, cached.cachedAt); }
    else {
      setKeywordRankData(null);
      setKeywordRankCachedAt(null);
      setKeywordRankError(null);
      setSnapshotNotice("No saved Keyword Rank data for this account yet — waiting for the scheduled data refresh.");
    }
    try {
      const { body, cachedAt } = await loadSharedReport(keywordRankParams);
      if (!isCurrentReq("keywordrank", myId)) return;
      if (body.snapshotMissing) {
        setKeywordRankData(null);
        setKeywordRankCachedAt(null);
        setSnapshotNotice(body.message);
      } else {
        setSnapshotNotice(null);
        applyKeywordRankData(body, cachedAt);
      }
    } catch (error) {
      if (!isCurrentReq("keywordrank", myId)) return;
      if (!cached) setKeywordRankError(error.message);
    }
  }, [applyKeywordRankData, keywordRankParams, bumpReq, isCurrentReq]);

  const fetchKeywordRank = useCallback(() => {
    if (!keywordRankParams || keywordRankLoading) return;
    setKeywordRankLoading(true);
    setKeywordRankError(null);
    refreshSharedReport(keywordRankParams)
      .then(({ body, cachedAt }) => applyKeywordRankData(body, cachedAt))
      .catch((err) => setKeywordRankError(err.message))
      .finally(() => setKeywordRankLoading(false));
  }, [applyKeywordRankData, keywordRankLoading, keywordRankParams]);

  useEffect(() => {
    if (view === "keywordrank") loadCachedKeywordRank();
  }, [view, loadCachedKeywordRank]);
  useAutoRevalidate(loadCachedKeywordRank, { active: view === "keywordrank" });

  /* ===== The six insight reports =====
     Each one is single-account, read from the shared Supabase snapshot on
     navigation, and refreshed only by the header Refresh button. The as-of date
     is part of the snapshot scope; every filter, threshold and sort inside the
     report is local and deliberately NOT part of it. */
  const insightScope = useMemo(
    () => (selectedAccountId ? { ids: selectedAccountId, to: TODAY } : null),
    [selectedAccountId, TODAY]
  );
  const salesMoversParams = useMemo(
    () => (insightScope ? { action: "sales-movers", ...insightScope } : null),
    [insightScope]
  );
  const listingHealthParams = useMemo(
    () => (insightScope ? { action: "listing-health", ...insightScope } : null),
    [insightScope]
  );
  const buyBoxParams = useMemo(
    () => (insightScope ? { action: "buy-box-loss", ...insightScope } : null),
    [insightScope]
  );
  const returnsParams = useMemo(
    () => (insightScope ? { action: "returns-leakage", ...insightScope } : null),
    [insightScope]
  );
  const ppcParams = useMemo(
    () => (insightScope ? { action: "ppc-performance", ...insightScope } : null),
    [insightScope]
  );
  const optimizerParams = useMemo(
    () => (insightScope ? { action: "listing-optimizer", ...insightScope } : null),
    [insightScope]
  );
  // SKU Movement is BRAND-scoped (unlike the insight reports), so its snapshot identity includes the selected brand.
  // Read-only + durable: loading/reloading/changing account or brand only reads saved OLI+Catalog, never DataDoe.
  const skuMovementParams = useMemo(
    () => (selectedAccountId ? { action: "sku-movement", reportVersion: "sku-movement/v2", ids: selectedAccountId, brand: selectedBrand, to: TODAY } : null),
    [selectedAccountId, selectedBrand, TODAY]
  );

  // The Priority Feed combines all six, so each report also loads its shared
  // snapshot while the feed is open. That is a snapshot read, never a DataDoe
  // call, so opening the feed still costs no export.
  const onFeed = view === "priority";
  const salesMovers = useSharedReport({ params: salesMoversParams, active: view === "salesmovers" || onFeed });
  const listingHealth = useSharedReport({ params: listingHealthParams, active: view === "listinghealth" || onFeed });
  const buyBox = useSharedReport({ params: buyBoxParams, active: view === "buybox" || onFeed });
  const returns = useSharedReport({ params: returnsParams, active: view === "returns" || onFeed });
  const ppc = useSharedReport({ params: ppcParams, active: view === "ppc" || onFeed });
  const optimizer = useSharedReport({ params: optimizerParams, active: view === "optimizer" || onFeed });
  const skuMovement = useSharedReport({ params: skuMovementParams, active: view === "skumovement" });
  useEffect(() => { skuReloadRef.current = skuMovement.reload; }, [skuMovement.reload]);

  const INSIGHT_VIEWS = useMemo(() => ({
    salesmovers: { report: salesMovers, label: "Sales Movers" },
    listinghealth: { report: listingHealth, label: "Listing Health" },
    buybox: { report: buyBox, label: "Buy Box Loss" },
    returns: { report: returns, label: "Returns & Refund Leakage" },
    ppc: { report: ppc, label: "PPC Performance" },
    optimizer: { report: optimizer, label: "Listing & Search Optimizer" },
  }), [salesMovers, listingHealth, buyBox, returns, ppc, optimizer]);
  const activeInsightReport = INSIGHT_VIEWS[view]?.report || null;

  // Every insight report returns the brands present in its own scope so the
  // shared header selector is usable from these reports alone, exactly like the
  // SKU P&L and Keyword Rank reports already do. Brands stay account-scoped.
  useEffect(() => {
    const body = activeInsightReport?.data;
    if (!body || body.snapshotMissing) return;
    if (body.accountId && Array.isArray(body.catalogBrands) && body.catalogBrands.length) {
      setCatalogBrands(body.catalogBrands);
      setCatalogBrandsAccountId(body.accountId);
    }
  }, [activeInsightReport?.data]);

  // SKU Movement carries the same account-scoped catalog brands, so its view can drive the shared header selector too.
  useEffect(() => {
    const body = skuMovement?.data;
    if (!body || body.snapshotMissing) return;
    if (body.accountId && Array.isArray(body.catalogBrands) && body.catalogBrands.length) {
      setCatalogBrands(body.catalogBrands);
      setCatalogBrandsAccountId(body.accountId);
    }
  }, [skuMovement?.data]);

  const dailyCurrency = selectedMarketplace.currency || "INR";
  const refreshScopeAccount = accountById[selectedAccountId];
  const dailyReport = useMemo(() => {
    // The report HORIZON is the ACCOUNT's latest proven date (dailyCompleteness.latestDate -- account-level, read
    // live from source_oli_completeness, IDENTICAL for All Brands and every named brand), NOT the selected brand's
    // last sale. So a covered date on which the selected brand had no activity still renders (as an honest numeric
    // zero -- the per-column sum below is 0) instead of shortening the table to the brand's last-sold date. Fall
    // back to the latest sales-bearing row (then any row) only when completeness is unavailable.
    const yesterday = addDays(TODAY, -1);
    const rowsWithSales = dailyRows.filter((r) => Number(r.total_sales) > 0 || Number(r.total_units_sold) > 0);
    const coverageLatest = dailyCompleteness && /^\d{4}-\d{2}-\d{2}$/.test(String(dailyCompleteness.latestDate || "")) ? dailyCompleteness.latestDate : null;
    let latest = coverageLatest
      || rowsWithSales.reduce((mx, r) => (!mx || r.date > mx ? r.date : mx), null)
      || dailyRows.reduce((mx, r) => (!mx || r.date > mx ? r.date : mx), null)
      || yesterday;
    if (latest > yesterday) latest = yesterday;
    const columns = dailyReportColumns(latest, 3, 5);
    const cells = columns.map((col) => {
      let sales = 0, units = 0, adSales = 0, adSpend = 0, clicks = 0, hasAd = false;
      dailyRows.forEach((r) => {
        if (r.date < col.from || r.date > col.to) return;
        sales += r.total_sales || 0;
        units += r.total_units_sold || 0;
        const as = pickNum(r, AD_SALES_KEYS), sp = pickNum(r, AD_SPEND_KEYS), ck = pickNum(r, CLICKS_KEYS);
        if (as !== null || sp !== null || ck !== null) hasAd = true;
        adSales += as || 0; adSpend += sp || 0; clicks += ck || 0;
      });
      return { sales, units, adSales, adSpend, clicks, hasAd };
    });
    return { latest, columns, cells };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyRows, dailyCompleteness]);

  // Derived FBA Shipment Plan: raw rows -> computed metrics -> filter -> sort.
  // Everything here is local, so search/sort/target/config changes never refetch (ZERO DataDoe).
  const planComputed = useMemo(() => {
    if (!planData || !Array.isArray(planData.rows)) return [];
    const monthKeys = (planData.months || []).map((m) => m.key);
    const effectiveAsOf = planData.salesLatestDate || planData.asOf || null;
    const daysInCurrentMonth = planData.currentMonth?.daysInMonth || null;
    const awdSourceValidated = planData.isUS === true && planData.awdAvailable === true;
    const built = planData.rows.map((r) => {
      const legacy = computePlanRow(r, planData, targetDays); // preserved existing columns (unchanged)
      const wh = r.sku ? planWarehouseBySku.get(String(r.sku)) : null;
      const { horizon: resolvedHorizon, source: horizonSource } = resolveHorizon({
        skuOverride: r.sku ? planSkuOverrides.get(String(r.sku)) : null, accountDefault: planAccountSettings.horizon,
      });
      const planning = computePlanningRow({
        isUS: planData.isUS === true,
        effectiveAsOf, daysInCurrentMonth, inventoryAvailable: planData.inventoryAvailable === true,
        available: r.fbaAvailable, customerOrderReserved: r.customerOrderReserved ?? null,
        reservedFcTransfer: r.reservedFcTransfer, reservedFcProcessing: r.reservedFcProcessing,
        inboundWorking: r.inboundWorking, inboundShipped: r.inboundShipped, inboundReceived: r.inboundReceived,
        awdValidated: awdSourceValidated, awdAvailable: r.awdAvailable, awdInbound: r.awdInbound ?? null,
        sellerWarehouseQty: wh ? wh.qty : null,
        // A completed month with proven evidence is a number (covered zero = 0); a genuinely absent month stays null
        // so the forecast engine never treats a missing month as 0.
        monthlyValues: monthKeys.map((k) => { const v = r.unitsByMonth?.[k]; return v == null ? null : Number(v); }), mtdUnits: r.mtdUnits, elapsedCompletedDays: planData.elapsedDays,
        forecastMethod: planAccountSettings.forecastMethod, forecastWeights: planAccountSettings.forecastWeights,
        horizon: resolvedHorizon, safetyDays: planAccountSettings.safetyDays,
      });
      // Null-aware month values for DISPLAY (a genuinely absent month stays null -> em dash, never a coerced 0).
      const monthsDisplay = monthKeys.map((k) => { const v = r.unitsByMonth?.[k]; return v == null ? null : Number(v); });
      const skuHasOverride = !!(r.sku && planSkuOverrides.get(String(r.sku)));
      // ONE canonical inventory model for every display/total/export/plan number: derived from the engine, so the
      // table, footer, export and planning can never disagree. Demand uses the corrected daily run rate; supply is
      // the amazonNetworkPosition (FBA + distributable AWD; awd_inbound + customer-reserve excluded).
      const amazonNetwork = planning.amazonNetworkPosition;
      const targetUnits = planning.dailyRunRate == null ? null : Math.round(planning.dailyRunRate * (Number(targetDays) || 0));
      const recommended = (amazonNetwork == null || targetUnits == null) ? null : Math.max(0, Math.ceil(targetUnits - amazonNetwork));
      return {
        ...legacy, planning, horizonSource, effectiveHorizon: resolvedHorizon, skuHasOverride, monthsDisplay,
        reserved: planning.reservedFcTotal, inboundPipeline: planning.inboundPipeline,
        awd: planning.awdAvailable, awdInbound: planning.awdInbound,
        totalFbaInv: planning.totalFbaInventory, amazonNetwork,
        targetUnits, recommended, remark: recommended == null ? null : recommended > 0 ? "Restock" : "OK",
        rowKey: r.asin, warehouse: wh || null, marketplace: wh?.marketplace || planData.marketCountry || null,
      };
    });

    // Synthetic WAREHOUSE-ONLY rows: a SKU the seller saved a warehouse quantity for that the per-ASIN plan does not
    // already show (its ASIN had zero sales + zero Amazon inventory, or it is a non-representative SKU). It appears
    // with its Seller WH units + honest em dashes for every FBA/AWD/sales figure (inventory genuinely unavailable for
    // it -> never a fabricated 0). This satisfies "a saved warehouse SKU must appear in the plan".
    const seenSkus = new Set(built.map((r) => r.sku).filter(Boolean).map(String));
    const synthetic = [];
    for (const [sku, wh] of planWarehouseBySku) {
      const key = String(sku);
      if (seenSkus.has(key)) continue;
      const { horizon: resolvedHorizon, source: horizonSource } = resolveHorizon({
        skuOverride: planSkuOverrides.get(key) || null, accountDefault: planAccountSettings.horizon,
      });
      const planning = computePlanningRow({
        isUS: planData.isUS === true, effectiveAsOf, daysInCurrentMonth, inventoryAvailable: false,
        available: null, customerOrderReserved: null, reservedFcTransfer: null, reservedFcProcessing: null,
        inboundWorking: null, inboundShipped: null, inboundReceived: null,
        awdValidated: false, awdAvailable: null, awdInbound: null, sellerWarehouseQty: wh.qty,
        monthlyValues: [null, null, null], mtdUnits: null, elapsedCompletedDays: planData.elapsedDays,
        forecastMethod: planAccountSettings.forecastMethod, forecastWeights: planAccountSettings.forecastWeights,
        horizon: resolvedHorizon, safetyDays: planAccountSettings.safetyDays,
      });
      // Identity from the durable directory (keeps childAsin/product/brand even for a dropped or manual SKU). A SKU
      // with no proven catalog brand stays Unmapped (brand null) -- never placed under another brand.
      const dirEntry = planSkuDirectory.get(key) || null;
      const asin = (dirEntry && dirEntry.childAsin) || wh.childAsin || "";
      const brand = (dirEntry && dirEntry.brand) || (asin && planCatalogByAsin[asin]?.brand) || null;
      const productName = (dirEntry && dirEntry.productName) || (asin && planCatalogByAsin[asin]?.productName) || null;
      synthetic.push({
        asin, rowKey: `wh:${key}`, warehouseOnly: true,
        productName: productName || "(warehouse-only SKU)", brand, sku: key,
        monthsDisplay: [null, null, null], m1: null, m2: null, m3: null, mtdUnits: null,
        threeMoAvg: null, mtdProjected: null, planningAvg: null, targetUnits: null,
        fbaAvailable: null, mtdDrr: null, fbaDaysCover: null, invKnown: false, isUS: planData.isUS === true,
        reserved: null, inboundPipeline: null, awd: null, awdInbound: null, totalFbaInv: null, amazonNetwork: null,
        recommended: null, remark: null, planning, horizonSource, effectiveHorizon: resolvedHorizon,
        skuHasOverride: !!planSkuOverrides.get(key), warehouse: wh, marketplace: wh.marketplace || planData.marketCountry || null,
      });
    }
    return [...built, ...synthetic];
  }, [planData, targetDays, planAccountSettings, planSkuOverrides, planWarehouseBySku, planSkuDirectory, planCatalogByAsin]);

  // Brand filtering: All -> everything; "Unmapped" -> only rows with NO catalog-proven brand; a named brand -> only
  // rows whose canonical brandKey matches (whitespace-normalized, case-folded, punctuation-significant -- the shared
  // brandKey). A named brand NEVER falls back to All; Unmapped rows never appear under a named brand.
  const planRows = useMemo(() => {
    const filtered = planComputed.filter((r) => planSearchMatch(r, planSearch) && matchesPlanBrand(r.brand, selectedBrand, brandKey));
    return [...filtered].sort((a, b) => comparePlanRows(a, b, planSort.key, planSort.dir));
  }, [planComputed, planSearch, planSort, selectedBrand]);

  const planTotals = useMemo(() => {
    const t = { m1: 0, m2: 0, m3: 0, mtdUnits: 0, targetUnits: 0, fbaAvailable: 0, mtdDrr: 0, fbaDaysCover: null, custReserved: 0, reserved: 0, inboundPipeline: 0, awd: 0, awdInbound: 0, totalFbaInv: 0, amazonNetwork: 0, recommended: 0, restockCount: 0,
      pipeline: 0, horizonDemand: 0, safetyStock: 0, targetInventory: 0, sellerWh: 0, shipWh: 0, production: 0 };
    let anyInv = false, anyAwd = false, anyAwdInbound = false;
    const add = (key, v) => { if (v != null && Number.isFinite(Number(v))) t[key] += Number(v); };
    planRows.forEach((r) => {
      t.m1 += r.m1; t.m2 += r.m2; t.m3 += r.m3; t.mtdUnits += r.mtdUnits;
      add("targetUnits", r.targetUnits);
      if (r.fbaAvailable !== null) {
        anyInv = true;
        t.fbaAvailable += r.fbaAvailable;
        if (r.mtdDrr !== null) t.mtdDrr += r.mtdDrr;
        add("reserved", r.reserved); add("inboundPipeline", r.inboundPipeline);
        add("totalFbaInv", r.totalFbaInv); add("amazonNetwork", r.amazonNetwork);
        add("custReserved", r.planning?.customerOrderReserved);
        add("pipeline", r.planning?.amazonPipeline);
      }
      if (r.awd !== null) { anyAwd = true; t.awd += r.awd; }
      if (r.awdInbound != null) { anyAwdInbound = true; t.awdInbound += Number(r.awdInbound); }
      if (r.recommended !== null) t.recommended += r.recommended;
      if (r.remark === "Restock") t.restockCount += 1;
      // Planning outputs (each null-safe; a null contributes nothing but never fabricates a 0 header total).
      add("horizonDemand", r.planning?.horizonDemand); add("safetyStock", r.planning?.safetyStockUnits);
      add("targetInventory", r.planning?.targetInventory); add("sellerWh", r.planning?.sellerWarehouseQty);
      add("shipWh", r.planning?.shipFromSellerWarehouse); add("production", r.planning?.productionRequirement);
    });
    t.fbaDaysCover = t.mtdDrr > 0 ? t.fbaAvailable / t.mtdDrr : null;
    t.anyInv = anyInv; t.anyAwd = anyAwd; t.anyAwdInbound = anyAwdInbound;
    return t;
  }, [planRows]);

  // The full ordered column model (identity + sales + forecast + inventory + planning + status). Each column owns its
  // header metadata + cell + footer renderer, so the grouped column chooser and the table stay perfectly in sync. AWD
  // columns are tagged so they vanish for non-US accounts (never a fake 0). `nInt` renders null as an em dash.
  const planColumns = useMemo(() => {
    if (!planData) return [];
    const months = planData.months || [];
    const mLabel = (i) => monthKeyLabel(months[i]?.key) || `Month ${i + 1}`;
    const td = (key, val, cls = "mono") => <td key={key} className={cls}>{nInt(val)}</td>;
    return [
      { id: "asin", group: "Identity", label: "Product / ASIN", chooserLabel: "Product / ASIN", align: "left", sortKey: "asin", locked: true,
        cell: (r) => (<td key="asin" className="pt-id"><div className="pt-name" title={r.productName || r.asin}>{r.productName || "(no product name)"}</div><div className="pt-meta mono">{r.asin || (r.warehouseOnly ? "warehouse only" : "")}{r.sku ? `${r.asin || r.warehouseOnly ? " · " : ""}${r.sku}` : ""}</div>{r.brand && <div className="pt-brand">{r.brand}</div>}</td>),
        foot: (t, rows) => <td key="asin" className="pt-id">Totals · {rows.length} ASIN{rows.length === 1 ? "" : "s"}</td> },
      { id: "m1", group: "Sales", label: mLabel(0), chooserLabel: "Month 1 units", sortKey: "m1", cell: (r) => td("m1", r.monthsDisplay?.[0]), foot: (t) => td("m1", t.m1) },
      { id: "m2", group: "Sales", label: mLabel(1), chooserLabel: "Month 2 units", sortKey: "m2", cell: (r) => td("m2", r.monthsDisplay?.[1]), foot: (t) => td("m2", t.m2) },
      { id: "m3", group: "Sales", label: mLabel(2), chooserLabel: "Month 3 units", sortKey: "m3", cell: (r) => td("m3", r.monthsDisplay?.[2]), foot: (t) => td("m3", t.m3) },
      { id: "mtdUnits", group: "Sales", label: "MTD", chooserLabel: "MTD units", sortKey: "mtdUnits", cell: (r) => td("mtdUnits", r.mtdUnits), foot: (t) => td("mtdUnits", t.mtdUnits) },
      { id: "threeMoAvg", group: "Forecast", label: "3M Avg", chooserLabel: "3-month average", sortKey: "threeMoAvg", cell: (r) => td("threeMoAvg", r.planning?.threeMonthAverage), foot: () => <td key="threeMoAvg" className="mono">—</td> },
      { id: "mtdProjected", group: "Forecast", label: "MTD Proj.", chooserLabel: "MTD projected", sortKey: "mtdProjected", cell: (r) => td("mtdProjected", r.planning?.mtdProjectedUnits), foot: () => <td key="mtdProjected" className="mono">—</td> },
      { id: "targetUnits", group: "Forecast", label: `Target Units (${targetDays || 0}d)`, chooserLabel: "Target units (target-days)", sortKey: "targetUnits", thTitle: "Corrected daily run rate (the account forecast method) × the target-days input. Unavailable (em dash) when the forecast can't be derived.", cell: (r) => td("targetUnits", r.targetUnits, "mono pt-strong"), foot: (t) => td("targetUnits", t.targetUnits, "mono pt-strong") },
      { id: "fbaAvailable", group: "Inventory", label: "FBA Avail", chooserLabel: "FBA available", sortKey: "fbaAvailable", cell: (r) => td("fbaAvailable", r.fbaAvailable), foot: (t) => <td key="fbaAvailable" className="mono">{t.anyInv ? nInt(t.fbaAvailable) : "—"}</td> },
      { id: "fbaDaysCover", group: "Inventory", label: "FBA Days (MTD DRR)", chooserLabel: "FBA days cover", sortKey: "fbaDaysCover", cell: (r) => td("fbaDaysCover", r.fbaDaysCover), foot: (t) => <td key="fbaDaysCover" className="mono">{t.anyInv ? nInt(t.fbaDaysCover) : "—"}</td> },
      { id: "custReserved", group: "Inventory", label: "Cust. Reserved", chooserLabel: "Customer reserved", thTitle: "reserved_customer_order — units already allocated to placed customer orders. DISPLAY ONLY: already sold, never counted as usable/planning stock.", cell: (r) => td("custReserved", r.planning?.customerOrderReserved), foot: (t) => <td key="custReserved" className="mono">{t.anyInv ? nInt(t.custReserved) : "—"}</td> },
      { id: "reserved", group: "Inventory", label: "Reserved (FC)", chooserLabel: "Reserved (FC transfer + processing)", sortKey: "reserved", thTitle: "reserved_fc_transfer + reserved_fc_processing (raw, no subtraction) — in-FC, temporarily unavailable, becoming sellable. Distinct from Cust. Reserved.", cell: (r) => td("reserved", r.reserved), foot: (t) => <td key="reserved" className="mono">{t.anyInv ? nInt(t.reserved) : "—"}</td> },
      { id: "reservedFcTransfer", group: "Inventory", label: "FC Transfer", chooserLabel: "· reserved_fc_transfer (raw)", defaultHidden: true, thTitle: "reserved_fc_transfer (raw). A component of Reserved (FC).", cell: (r) => td("reservedFcTransfer", r.planning?.reservedFcTransfer), foot: () => <td key="reservedFcTransfer" className="mono">—</td> },
      { id: "reservedFcProcessing", group: "Inventory", label: "FC Processing", chooserLabel: "· reserved_fc_processing (raw)", defaultHidden: true, thTitle: "reserved_fc_processing (raw). A component of Reserved (FC).", cell: (r) => td("reservedFcProcessing", r.planning?.reservedFcProcessing), foot: () => <td key="reservedFcProcessing" className="mono">—</td> },
      { id: "inboundPipeline", group: "Inventory", label: "Inbound Pipeline", chooserLabel: "Inbound pipeline (working+shipped+received)", sortKey: "inboundPipeline", thTitle: "inbound_working + inbound_shipped + inbound_received — en route to the FBA network, not yet sellable.", cell: (r) => td("inboundPipeline", r.inboundPipeline), foot: (t) => <td key="inboundPipeline" className="mono">{t.anyInv ? nInt(t.inboundPipeline) : "—"}</td> },
      { id: "inboundWorking", group: "Inventory", label: "Inbound Working", chooserLabel: "· inbound_working (raw)", defaultHidden: true, thTitle: "inbound_working (raw). A component of Inbound Pipeline.", cell: (r) => td("inboundWorking", r.planning?.inboundWorking), foot: () => <td key="inboundWorking" className="mono">—</td> },
      { id: "inboundShipped", group: "Inventory", label: "Inbound Shipped", chooserLabel: "· inbound_shipped (raw)", defaultHidden: true, thTitle: "inbound_shipped (raw). A component of Inbound Pipeline.", cell: (r) => td("inboundShipped", r.planning?.inboundShipped), foot: () => <td key="inboundShipped" className="mono">—</td> },
      { id: "inboundReceived", group: "Inventory", label: "Inbound Received", chooserLabel: "· inbound_received (raw)", defaultHidden: true, thTitle: "inbound_received (raw). A component of Inbound Pipeline.", cell: (r) => td("inboundReceived", r.planning?.inboundReceived), foot: () => <td key="inboundReceived" className="mono">—</td> },
      { id: "awd", group: "Inventory", label: "AWD Avail", chooserLabel: "AWD available (distributable)", sortKey: "awd", awd: true, thTitle: "awd_available_distributable_quantity — distributable AWD stock; counts as usable replenishment supply. US only.", cell: (r) => td("awd", r.awd), foot: (t) => <td key="awd" className="mono">{t.anyAwd ? nInt(t.awd) : "—"}</td> },
      { id: "awdInbound", group: "Inventory", label: "AWD Inbound", chooserLabel: "AWD inbound (not yet distributable)", awd: true, thTitle: "awd_total_inbound_quantity — inbound TO the AWD warehouse, NOT yet distributable. DISPLAY ONLY: excluded from usable supply. US only.", cell: (r) => td("awdInbound", r.awdInbound), foot: (t) => <td key="awdInbound" className="mono">{t.anyAwdInbound ? nInt(t.awdInbound) : "—"}</td> },
      { id: "totalFbaInv", group: "Inventory", label: "Total FBA Inv.", chooserLabel: "Total FBA inventory (FBA only)", sortKey: "totalFbaInv", thTitle: "Sellable Now + Reserved (FC) + Inbound Pipeline. FBA network only — excludes AWD, seller warehouse and customer-order reserve.", cell: (r) => td("totalFbaInv", r.totalFbaInv), foot: (t) => <td key="totalFbaInv" className="mono">{t.anyInv ? nInt(t.totalFbaInv) : "—"}</td> },
      { id: "amazonNetwork", group: "Inventory", label: "Amazon Network Pos.", chooserLabel: "Amazon network position (FBA + AWD avail)", sortKey: "amazonNetwork", thTitle: "Total FBA Inv. + AWD Available — all Amazon-held stock that is or will become sellable. This is the planning supply.", cell: (r) => td("amazonNetwork", r.amazonNetwork), foot: (t) => <td key="amazonNetwork" className="mono">{t.anyInv ? nInt(t.amazonNetwork) : "—"}</td> },
      { id: "recommended", group: "Inventory", label: "Recommend", chooserLabel: "Recommend (target-days)", sortKey: "recommended", thTitle: "ceil(Target Units − Amazon Network Position), floored at 0.", cell: (r) => td("recommended", r.recommended, "mono pt-strong"), foot: (t) => <td key="recommended" className="mono pt-strong">{t.anyInv ? nInt(t.recommended) : "—"}</td> },
      { id: "pipeline", group: "Planning", label: "Pipeline", chooserLabel: "Pipeline", thTitle: "In-network stock not yet sellable: inbound working + shipped + received + FC processing + FC transfer (customer-order-reserved excluded)", cell: (r) => td("pipeline", r.planning?.amazonPipeline), foot: (t) => <td key="pipeline" className="mono">{t.anyInv ? nInt(t.pipeline) : "—"}</td> },
      { id: "horizon", group: "Planning", label: "Horizon", chooserLabel: "Planning horizon", thTitle: "Effective planning horizon (per-SKU override or account default). Click a SKU's value to override.", cell: (r) => <SkuHorizonCell key="horizon" row={r} onOpen={(row) => setSkuHorizonEdit({ sku: row.sku, asin: row.asin, effective: row.effectiveHorizon, source: row.horizonSource, hasOverride: row.skuHasOverride })} />, foot: () => <td key="horizon" className="mono">—</td> },
      { id: "horizonDemand", group: "Planning", label: "Horizon Demand", chooserLabel: "Horizon demand", thTitle: "Daily run rate × effective horizon days (calendar-aware from the effective-through date)", cell: (r) => td("horizonDemand", r.planning?.horizonDemand), foot: (t) => td("horizonDemand", t.horizonDemand) },
      { id: "safety", group: "Planning", label: "Safety", chooserLabel: "Safety stock", thTitle: "Daily run rate × safety days", cell: (r) => td("safety", r.planning?.safetyStockUnits), foot: (t) => td("safety", t.safetyStock) },
      { id: "targetInv", group: "Planning", label: "Target Inv", chooserLabel: "Target inventory", thTitle: "ceil(Horizon Demand + Safety Stock)", cell: (r) => td("targetInv", r.planning?.targetInventory, "mono pt-strong"), foot: (t) => td("targetInv", t.targetInventory, "mono pt-strong") },
      { id: "sellerWh", group: "Planning", label: "Seller WH", chooserLabel: "Seller warehouse", thTitle: "Your OWN uncommitted warehouse units for this SKU (click to edit). Never Amazon inventory and never units already in inbound working.", cell: (r) => <WarehouseCell key="sellerWh" row={r} onSave={saveWarehouseQty} busy={planConfigBusy} />, foot: (t) => td("sellerWh", t.sellerWh) },
      { id: "shipWh", group: "Planning", label: "Ship WH", chooserLabel: "Ship from warehouse", thTitle: "min(Seller WH, shortage after Amazon/AWD network stock)", cell: (r) => td("shipWh", r.planning?.shipFromSellerWarehouse), foot: (t) => td("shipWh", t.shipWh) },
      { id: "produce", group: "Planning", label: "Produce", chooserLabel: "Production requirement", thTitle: "max(0, shortage after Amazon/AWD network stock − Seller WH)", cell: (r) => td("produce", r.planning?.productionRequirement, "mono pt-strong"), foot: (t) => td("produce", t.production, "mono pt-strong") },
      { id: "stockout", group: "Planning", label: "Est. Stockout", chooserLabel: "Estimated stockout", thTitle: "Effective-through date + floor(Immediately Available / daily run rate)", cell: (r) => <td key="stockout" className="mono" title={r.planning?.estimatedStockoutDate ? "" : (r.planning?.stockoutReason || "")}>{r.planning?.estimatedStockoutDate ? fmtDateHuman(r.planning.estimatedStockoutDate) : <span className="dr-dash">—</span>}</td>, foot: () => <td key="stockout" className="mono">—</td> },
      { id: "priority", group: "Planning", label: "Priority", chooserLabel: "Priority", align: "left", cell: (r) => <td key="priority">{r.planning?.planningPriority && r.planning.planningPriority !== "Unknown" ? <span className={"pt-badge plan-prio-" + String(r.planning.planningPriority).toLowerCase()} title={r.planning.recommendedAction || ""}>{r.planning.planningPriority}</span> : "—"}</td>, foot: () => <td key="priority">—</td> },
      { id: "remark", group: "Status", label: "Remark", chooserLabel: "Stock remark", align: "left", sortKey: "remark", cell: (r) => <td key="remark">{r.remark ? <span className={"pt-badge " + (r.remark === "Restock" ? "pt-badge-restock" : "pt-badge-ok")}>{r.remark}</span> : "—"}</td>, foot: (t) => <td key="remark">{t.restockCount > 0 ? `${t.restockCount} restock` : "OK"}</td> },
    ];
  }, [planData, targetDays, saveWarehouseQty, planConfigBusy]);

  // Visible columns = model minus the user's hidden set, minus AWD columns for non-US accounts.
  const planVisibleColumns = useMemo(
    () => planColumns.filter((c) => (c.locked || !planHiddenCols.has(c.id)) && (planData?.isUS || !c.awd)),
    [planColumns, planHiddenCols, planData?.isUS]
  );
  // Presentation-only: consecutive same-group runs of the visible columns, for a
  // clear grouped header row (Identity / Sales / Forecast / Inventory / ...).
  const planGroupSpans = useMemo(() => {
    const runs = [];
    for (const c of planVisibleColumns) {
      const g = c.group || "";
      if (runs.length && runs[runs.length - 1].group === g) runs[runs.length - 1].span += 1;
      else runs.push({ group: g, span: 1 });
    }
    return runs;
  }, [planVisibleColumns]);
  // Grouped, ordered column list for the chooser (preserves model order within each group).
  const planColumnGroups = useMemo(() => {
    const order = []; const byGroup = new Map();
    for (const c of planColumns) { if (!byGroup.has(c.group)) { byGroup.set(c.group, []); order.push(c.group); } byGroup.get(c.group).push(c); }
    return order.map((group) => ({ group, cols: byGroup.get(group) }));
  }, [planColumns]);
  // Every SKU that belongs to this account (for import isolation) + its representative child ASIN.
  const planSkuAsinMap = useMemo(() => { const m = new Map(); for (const [sku, e] of planSkuDirectory) if (e.childAsin) m.set(sku, e.childAsin); return m; }, [planSkuDirectory]);
  const [planColsOpen, setPlanColsOpen] = useState(false);
  // Brand options for the FBA-plan selector: the account's catalog-proven brands present in the plan (incl. warehouse
  // rows), plus an explicit "Unmapped" option when any row lacks a proven brand. Scoped to this view only.
  const planBrandOptions = useMemo(() => {
    const set = new Set();
    let hasUnmapped = false;
    for (const r of planComputed) { if (r.brand) set.add(r.brand); else hasUnmapped = true; }
    const list = [...set].sort((a, b) => a.localeCompare(b));
    if (hasUnmapped) list.push(UNMAPPED_BRAND);
    return list;
  }, [planComputed]);

  const reconciliationScope = useMemo(
    () => buildReconciliation(reconciliationData, selectedBrand),
    [reconciliationData, selectedBrand]
  );
  const reconInSelectedMonth = useCallback((date) => (
    reconciliationMonth === "ALL" || reconMonthOf(date) === reconciliationMonth
  ), [reconciliationMonth]);
  const reconciliationOrdersForMonth = useMemo(
    () => reconciliationScope.orders.filter((order) => reconInSelectedMonth(order.orderDate)),
    [reconciliationScope.orders, reconInSelectedMonth]
  );
  const reconciliationSettlementsForMonth = useMemo(
    () => reconciliationScope.allSettlementRows.filter((settlement) => reconInSelectedMonth(settlement.settlementDate)),
    [reconciliationScope.allSettlementRows, reconInSelectedMonth]
  );
  const reconciliationMetrics = useMemo(() => {
    const shipped = reconciliationOrdersForMonth.filter((order) => /shipped/i.test(String(order.status)));
    const settledOrders = reconciliationOrdersForMonth.filter((order) => /settled/i.test(order.reconciliationStatus));
    const orderRevenue = reconciliationOrdersForMonth.reduce((sum, order) => sum + Number(order.orderRevenue || 0), 0);
    const settledRevenue = reconciliationOrdersForMonth.reduce((sum, order) => sum + Number(order.settledRevenue || 0), 0);
    const refunded = reconciliationOrdersForMonth.filter((order) => /refunded/i.test(order.reconciliationStatus));
    const refundAmount = reconciliationOrdersForMonth.reduce((sum, order) => sum + Number(order.refundAmount || 0), 0);
    const cancelled = reconciliationOrdersForMonth.filter((order) => isCancelledOrder(order.status));
    const reconciliationRate = shipped.length ? (settledOrders.length / shipped.length) * 100 : null;
    const netPayout = reconciliationSettlementsForMonth.reduce((sum, settlement) => sum + Number(settlement.netPayout || 0), 0);
    return {
      shippedOrders: shipped.length, settledOrders: settledOrders.length, orderGap: shipped.length - settledOrders.length,
      orderRevenue, settledRevenue, revenueGap: orderRevenue - settledRevenue,
      refunds: refunded.length, refundAmount, cancelled: cancelled.length, reconciliationRate, netPayout,
    };
  }, [reconciliationOrdersForMonth, reconciliationSettlementsForMonth]);
  const reconciliationTrend = useMemo(() => (reconciliationData?.months || []).map((month) => {
    const orders = reconciliationScope.orders.filter((order) => reconMonthOf(order.orderDate) === month);
    const shipped = orders.filter((order) => /shipped/i.test(String(order.status))).length;
    const settled = orders.filter((order) => /settled/i.test(order.reconciliationStatus)).length;
    return { month, label: reconMonthLabel(month), shipped, settled };
  }), [reconciliationData, reconciliationScope.orders]);
  const reconciliationDonut = useMemo(() => {
    const groups = [
      ["Settled", CHART.positive], ["Pending", CHART.gold], ["Cancelled", CHART.negative], ["Refunded", CHART.info],
    ];
    return groups.map(([label, fill]) => ({ label, fill, value: reconciliationOrdersForMonth.filter((order) => {
      if (label === "Settled") return order.reconciliationStatus === "Settled";
      if (label === "Refunded") return /Refunded/.test(order.reconciliationStatus);
      return order.reconciliationStatus === label;
    }).length }));
  }, [reconciliationOrdersForMonth]);
  const reconciliationWaterfall = useMemo(() => {
    const settlements = reconciliationSettlementsForMonth;
    const gross = settlements.reduce((sum, s) => sum + Number(s.settledRevenue || 0), 0);
    const tax = settlements.reduce((sum, s) => sum + Number(s.settledTax || 0), 0);
    const referral = settlements.reduce((sum, s) => sum + Number(s.referralFee || 0), 0);
    const fba = settlements.reduce((sum, s) => sum + Number(s.fbaFee || 0), 0);
    const refunds = settlements.reduce((sum, s) => sum + Number(s.refundedAmount || 0), 0);
    const net = settlements.reduce((sum, s) => sum + Number(s.netPayout || 0), 0);
    return [
      { label: "Gross revenue", value: gross, kind: "positive" }, { label: "Tax", value: tax, kind: "positive" },
      { label: "Referral fees", value: referral, kind: "negative" }, { label: "FBA fees", value: fba, kind: "negative" },
      { label: "Refunds", value: refunds, kind: "negative" },
      { label: "Other", value: net - gross - tax - referral - fba - refunds, kind: "negative" },
      { label: "Net payout", value: net, kind: "net" },
    ];
  }, [reconciliationSettlementsForMonth]);
  const reconciliationDaily = useMemo(() => {
    const groups = new Map();
    const keyFor = (date) => reconciliationMonth === "ALL" ? reconMonthOf(date) : date;
    reconciliationScope.orders.forEach((order) => {
      if (!reconInSelectedMonth(order.orderDate)) return;
      const key = keyFor(order.orderDate);
      const current = groups.get(key) || { key, label: reconciliationMonth === "ALL" ? reconMonthLabel(key) : key.slice(8), shipped: 0, settled: 0, refunds: 0, orderRevenue: 0, settledRevenue: 0 };
      if (/shipped/i.test(String(order.status))) current.shipped += 1;
      current.orderRevenue += Number(order.orderRevenue || 0);
      groups.set(key, current);
    });
    reconciliationScope.allSettlementRows.forEach((settlement) => {
      if (!reconInSelectedMonth(settlement.settlementDate)) return;
      const key = keyFor(settlement.settlementDate);
      const current = groups.get(key) || { key, label: reconciliationMonth === "ALL" ? reconMonthLabel(key) : key.slice(8), shipped: 0, settled: 0, refunds: 0, orderRevenue: 0, settledRevenue: 0 };
      if (settlement.settlementType === "ORDER") { current.settled += 1; current.settledRevenue += Number(settlement.settledRevenue || 0); }
      if (settlement.settlementType === "REFUND") current.refunds += 1;
      groups.set(key, current);
    });
    return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  }, [reconciliationMonth, reconciliationScope, reconInSelectedMonth]);
  const reconciliationExplorerRows = useMemo(() => {
    const search = reconciliationSearch.trim().toLowerCase();
    return reconciliationOrdersForMonth.filter((order) => {
      if (reconciliationStatusFilter !== "ALL" && String(order.status) !== reconciliationStatusFilter) return false;
      if (reconciliationReconFilter !== "ALL" && order.reconciliationStatus !== reconciliationReconFilter) return false;
      if (reconciliationB2BFilter !== "ALL" && (order.isBusiness ? "YES" : "NO") !== reconciliationB2BFilter) return false;
      if (reconciliationCrossMonthFilter === "CROSS" && !order.crossMonth) return false;
      if (reconciliationCrossMonthFilter === "SAME" && order.crossMonth) return false;
      if (reconciliationFrom && order.orderDate < reconciliationFrom) return false;
      if (reconciliationTo && order.orderDate > reconciliationTo) return false;
      if (!search) return true;
      return `${order.orderId} ${order.orderDate} ${order.status} ${order.fulfillmentChannel} ${order.reconciliationStatus} ${order.settlementDate || ""}`.toLowerCase().includes(search);
    });
  }, [reconciliationOrdersForMonth, reconciliationSearch, reconciliationStatusFilter, reconciliationReconFilter, reconciliationB2BFilter, reconciliationCrossMonthFilter, reconciliationFrom, reconciliationTo]);
  const reconciliationSortedRows = useMemo(() => [...reconciliationExplorerRows].sort((a, b) => {
    const av = a[reconciliationSort.key], bv = b[reconciliationSort.key];
    const aEmpty = av === null || av === undefined || av === "";
    const bEmpty = bv === null || bv === undefined || bv === "";
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    const compare = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return reconciliationSort.dir === "asc" ? compare : -compare;
  }), [reconciliationExplorerRows, reconciliationSort]);
  const reconciliationPageCount = Math.max(1, Math.ceil(reconciliationSortedRows.length / 50));
  const reconciliationPageRows = reconciliationSortedRows.slice((reconciliationPage - 1) * 50, reconciliationPage * 50);
  const reconciliationPages = useMemo(() => {
    const pages = new Set([1, reconciliationPageCount, reconciliationPage - 1, reconciliationPage, reconciliationPage + 1]);
    return [...pages].filter((page) => page >= 1 && page <= reconciliationPageCount).sort((a, b) => a - b);
  }, [reconciliationPage, reconciliationPageCount]);

  useEffect(() => { setReconciliationPage(1); }, [reconciliationMonth, reconciliationSearch, reconciliationStatusFilter, reconciliationReconFilter, reconciliationB2BFilter, reconciliationCrossMonthFilter, reconciliationFrom, reconciliationTo, selectedBrand]);

  const setPlanSortKey = useCallback((key) => {
    setPlanSort((prev) => {
      if (prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      // Text columns default to ascending; numeric columns to descending.
      const textCols = ["asin", "productName", "brand", "sku", "remark"];
      return { key, dir: textCols.includes(key) ? "asc" : "desc" };
    });
  }, []);

  const displayCurrency = selectedMarketplace.currency || "INR";

  /* ===== SKU P&L Analyzer derived data (all local, no refetch) ===== */
  // The effective currency is always a single currency; currencies are never mixed.
  const skuPlCurrencies = skuPlData?.currencies || [];
  const effectiveSkuCurrency = skuPlCurrencies.includes(skuPlCurrency)
    ? skuPlCurrency
    : (skuPlCurrencies.includes(displayCurrency) ? displayCurrency : skuPlCurrencies[0] || displayCurrency);

  // Rows scoped to one currency + the header brand, computed for the selected
  // month, keeping only rows with activity in scope.
  const skuPlComputed = useMemo(() => {
    if (!skuPlData?.rows) return [];
    return skuPlData.rows
      .filter((r) => r.currency === effectiveSkuCurrency)
      .filter((r) => selectedBrand === "ALL" || (r.brand || "Unassigned") === selectedBrand)
      .map((r) => computeSkuPlRow(r, skuPlMonth, cogsOverrides[cogsOverrideKey(selectedAccountId, r)]?.perUnit))
      .filter((r) => r.hasActivity);
  }, [skuPlData, effectiveSkuCurrency, selectedBrand, skuPlMonth, cogsOverrides, selectedAccountId]);

  const openCogsEditor = useCallback((row) => {
    setCogsEditRow(row);
    setCogsEditValue(row.cogsPerUnitOverride === null ? "" : String(row.cogsPerUnitOverride));
    setCogsEditError("");
  }, []);

  const closeCogsEditor = useCallback(() => {
    setCogsEditRow(null);
    setCogsEditValue("");
    setCogsEditError("");
  }, []);

  const saveCogsOverride = useCallback(() => {
    if (!cogsEditRow || !selectedAccountId) return;
    const valueText = cogsEditValue.trim();
    const perUnit = Number(valueText);
    if (!valueText || !Number.isFinite(perUnit) || perUnit < 0) {
      setCogsEditError("Enter a valid zero or positive per-unit cost.");
      return;
    }
    const key = cogsOverrideKey(selectedAccountId, cogsEditRow);
    const next = {
      ...cogsOverrides,
      [key]: { perUnit, updatedAt: new Date().toISOString(), sku: cogsEditRow.sku || null, asin: cogsEditRow.asin || null, currency: cogsEditRow.currency || null },
    };
    try { localStorage.setItem(COGS_OVERRIDE_STORAGE_KEY, JSON.stringify(next)); } catch (e) { /* state still keeps this session's correction */ }
    setCogsOverrides(next);
    closeCogsEditor();
  }, [cogsEditRow, cogsEditValue, cogsOverrides, closeCogsEditor, selectedAccountId]);

  const resetCogsOverride = useCallback(() => {
    if (!cogsEditRow || !selectedAccountId) return;
    const key = cogsOverrideKey(selectedAccountId, cogsEditRow);
    const next = { ...cogsOverrides };
    delete next[key];
    try { localStorage.setItem(COGS_OVERRIDE_STORAGE_KEY, JSON.stringify(next)); } catch (e) { /* state still resets this session */ }
    setCogsOverrides(next);
    closeCogsEditor();
  }, [cogsEditRow, cogsOverrides, closeCogsEditor, selectedAccountId]);

  // Blended margin over the whole in-scope set drives the thin-margin leak test.
  const skuPlBlendedMargin = useMemo(() => {
    const sales = skuPlComputed.reduce((s, r) => s + r.sales, 0);
    const profit = skuPlComputed.reduce((s, r) => s + r.profit, 0);
    return sales > 0 ? (profit / sales) * 100 : null;
  }, [skuPlComputed]);

  const skuPlKpis = useMemo(() => {
    const t = skuPlComputed.reduce((acc, r) => {
      acc.sales += r.sales; acc.profit += r.profit; acc.units += r.units;
      acc.cost += r.cost; acc.adSpend += r.adSpend; acc.fees += r.fees; acc.cogs += r.cogs;
      return acc;
    }, { sales: 0, profit: 0, units: 0, cost: 0, adSpend: 0, fees: 0, cogs: 0 });
    t.margin = t.sales > 0 ? (t.profit / t.sales) * 100 : null;
    return t;
  }, [skuPlComputed]);

  // Attach a single status/flag to each row from the blended-margin scope.
  const skuPlRows = useMemo(
    () => skuPlComputed.map((r) => ({ ...r, status: skuPlStatus(r, skuPlBlendedMargin) })),
    [skuPlComputed, skuPlBlendedMargin]
  );

  const skuPlTopProfit = useMemo(
    () => [...skuPlRows].sort((a, b) => b.profit - a.profit).slice(0, 8),
    [skuPlRows]
  );
  const skuPlLeaks = useMemo(
    () => skuPlRows.filter((r) => r.status.key !== "ok")
      .sort((a, b) => a.profit - b.profit)
      .slice(0, 12),
    [skuPlRows]
  );
  const skuPlStatusCounts = useMemo(() => {
    const counts = { loss: 0, cogs: 0, ad: 0, thin: 0, ok: 0 };
    skuPlRows.forEach((r) => { counts[r.status.key] = (counts[r.status.key] || 0) + 1; });
    return counts;
  }, [skuPlRows]);

  const skuPlFiltered = useMemo(() => {
    const q = skuPlSearch.trim().toLowerCase();
    return skuPlRows.filter((r) => {
      if (skuPlStatusFilter !== "ALL" && r.status.key !== skuPlStatusFilter) return false;
      if (!q) return true;
      return `${r.asin || ""} ${r.sku || ""} ${r.productName || ""} ${r.brand || ""}`.toLowerCase().includes(q);
    });
  }, [skuPlRows, skuPlSearch, skuPlStatusFilter]);

  const skuPlSorted = useMemo(() => {
    const acc = {
      productName: (r) => (r.productName || "").toLowerCase(),
      sku: (r) => (r.sku || "").toLowerCase(),
      sales: (r) => r.sales, profit: (r) => r.profit, margin: (r) => (r.margin === null ? -Infinity : r.margin),
      units: (r) => r.units, cost: (r) => r.cost, fees: (r) => r.fees, adSpend: (r) => r.adSpend,
      cogs: (r) => r.cogs, adSalesRatio: (r) => (r.adSalesRatio === null ? Infinity : r.adSalesRatio),
      status: (r) => r.status.label,
    }[skuPlSort.key] || ((r) => r.profit);
    return [...skuPlFiltered].sort((a, b) => {
      const av = acc(a), bv = acc(b);
      const cmp = typeof av === "string" || typeof bv === "string" ? String(av).localeCompare(String(bv)) : av - bv;
      return skuPlSort.dir === "asc" ? cmp : -cmp;
    });
  }, [skuPlFiltered, skuPlSort]);

  const skuPlPageCount = Math.max(1, Math.ceil(skuPlSorted.length / 50));
  const skuPlSafePage = Math.min(skuPlPage, skuPlPageCount);
  const skuPlPageRows = skuPlSorted.slice((skuPlSafePage - 1) * 50, skuPlSafePage * 50);
  const skuPlPages = useMemo(() => {
    const pages = new Set([1, skuPlPageCount, skuPlSafePage - 1, skuPlSafePage, skuPlSafePage + 1]);
    return [...pages].filter((p) => p >= 1 && p <= skuPlPageCount).sort((a, b) => a - b);
  }, [skuPlSafePage, skuPlPageCount]);
  const skuPlMonthLabel = skuPlMonth === "ALL" ? "All 6 Months" : reconMonthLabel(skuPlMonth);
  const setSkuPlSortKey = useCallback((key) => {
    setSkuPlSort((prev) => prev.key === key
      ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { key, dir: ["productName", "sku", "status"].includes(key) ? "asc" : "desc" });
  }, []);

  const contentChangeEvents = useMemo(() => {
    const search = contentChangesSearch.trim().toLowerCase();
    return (contentChangesData?.events || []).filter((event) => {
      if (selectedBrand !== "ALL" && !(event.brands || []).includes(selectedBrand)) return false;
      if (contentChangesType !== "ALL" && event.notificationType !== contentChangesType) return false;
      if (!search) return true;
      return [event.eventTime, event.notificationType, event.notificationId, ...(event.asins || []), ...(event.brands || []), event.metadataPreview, event.payloadPreview]
        .join(" ").toLowerCase().includes(search);
    });
  }, [contentChangesData, contentChangesSearch, contentChangesType, selectedBrand]);

  const contentChangeTypes = useMemo(
    () => [...new Set((contentChangesData?.events || []).map((event) => event.notificationType).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [contentChangesData]
  );
  const contentChangeStats = useMemo(() => {
    const events = contentChangesData?.events || [];
    return {
      total: events.length,
      asinLinked: events.filter((event) => event.asins?.length).length,
      brandLinked: events.filter((event) => event.brands?.length).length,
      latest: events[0]?.eventTime || null,
    };
  }, [contentChangesData]);

  /* ===== Keyword Rank & Share Tracker derived data (all local, no refetch) ===== */
  const keywordRankRows = useMemo(
    () => buildKeywordRows(keywordRankData, selectedBrand),
    [keywordRankData, selectedBrand]
  );
  const keywordRankAsins = useMemo(() => [...new Map(
    keywordRankRows.map((row) => [row.asin, { asin: row.asin, name: row.productName }])
  ).values()].sort((a, b) => String(a.name || a.asin).localeCompare(String(b.name || b.asin))), [keywordRankRows]);
  const keywordRankStatusCounts = useMemo(() => {
    const counts = { lost: 0, slipping: 0, rising: 0, emerging: 0, stable: 0, baseline: 0 };
    keywordRankRows.forEach((row) => { counts[row.status] = (counts[row.status] || 0) + 1; });
    return counts;
  }, [keywordRankRows]);
  const keywordRankFiltered = useMemo(() => {
    const search = keywordRankSearch.trim().toLowerCase();
    return keywordRankRows.filter((row) => {
      if (keywordRankAsin !== "ALL" && row.asin !== keywordRankAsin) return false;
      if (keywordRankStatus !== "ALL" && row.status !== keywordRankStatus) return false;
      if (!search) return true;
      return `${row.query} ${row.asin} ${row.productName || ""} ${row.brand || ""}`.toLowerCase().includes(search);
    });
  }, [keywordRankRows, keywordRankAsin, keywordRankStatus, keywordRankSearch]);
  const keywordRankSorted = useMemo(() => {
    const accessors = {
      priority: (row) => sqpStatusPriority(row.status),
      productName: (row) => String(row.productName || row.asin).toLowerCase(),
      query: (row) => row.query.toLowerCase(),
      volume: (row) => row.latest.volume,
      impressionShare: (row) => row.latest.impressionShare,
      shareDelta: (row) => row.impressionShareDelta,
      rank: (row) => row.latest.rank ?? 101,
      rankDelta: (row) => row.rankDelta,
      conversion: (row) => row.conversionRate,
      moneyScore: (row) => row.moneyScore,
      status: (row) => row.statusMeta.label,
    };
    const accessor = accessors[keywordRankSort.key] || accessors.priority;
    return [...keywordRankFiltered].sort((a, b) => {
      const av = accessor(a), bv = accessor(b);
      const compare = typeof av === "string" || typeof bv === "string" ? String(av).localeCompare(String(bv)) : av - bv;
      return keywordRankSort.dir === "asc" ? compare : -compare;
    });
  }, [keywordRankFiltered, keywordRankSort]);
  const keywordRankStats = useMemo(() => ({
    moneyKeywords: keywordRankRows.length,
    atRisk: keywordRankStatusCounts.lost + keywordRankStatusCounts.slipping,
    emerging: keywordRankStatusCounts.emerging,
    stable: keywordRankStatusCounts.stable + keywordRankStatusCounts.rising,
  }), [keywordRankRows.length, keywordRankStatusCounts]);
  const setKeywordRankSortKey = useCallback((key) => {
    setKeywordRankSort((prev) => prev.key === key
      ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { key, dir: ["priority", "productName", "query", "status"].includes(key) ? "asc" : "desc" });
  }, []);

  function rowCurrency(r) {
    return r.currency || accountById[r.seller_or_vendor_id]?.currency || "INR";
  }
  function salesInDisplay(r) {
    return r.total_sales;
  }

  function aggregate(rowSet) {
    let sales = 0, units = 0, orders = 0, missingOrderValueUnits = 0;
    rowSet.forEach((r) => {
      units += r.total_units_sold || 0;
      orders += r.total_orders || 0;
      sales += salesInDisplay(r);
      // TYPED missing-order-value evidence only (non-cancelled units whose order value is genuinely NULL/missing).
      // The ambiguous legacy `unpriced_units` (sales===0 && units>0, which also caught cancelled + present-zero
      // promotional units) is retired: a legacy payload carrying only `unpriced_units` reads as 0 here, so a stale
      // snapshot can never resurrect the old banner.
      missingOrderValueUnits += r.missing_order_value_units || 0;
    });
    return { sales, units, orders, missingOrderValueUnits };
  }

  const brandRows = useMemo(
    () => rows.filter((r) => selectedBrand === "ALL" || productBrand(r) === selectedBrand),
    [rows, selectedBrand]
  );
  const [scopeMin, scopeMax] = useMemo(() => {
    let mn = null, mx = null;
    brandRows.forEach((r) => {
      if (!mn || r.date < mn) mn = r.date;
      if (!mx || r.date > mx) mx = r.date;
    });
    return [mn, mx];
  }, [brandRows]);
  const latest = scopeMax || TODAY;

  function productBrand(r) {
    return String(r.product_brand || "Unassigned").trim() || "Unassigned";
  }
  const cachedAccountBrands = useMemo(
    () => readCachedCatalogBrands(selectedAccountId),
    [selectedAccountId, catalogBrands, catalogBrandsAccountId]
  );
  const brandList = useMemo(() => {
    // Never carry a prior account's in-memory catalog into the newly selected
    // account. Only rows whose account was selected contribute a brand.
    const currentRowBrands = rows.map(productBrand).filter((brand) => brand !== "Unassigned");
    const currentSnapshotBrands = catalogBrandsAccountId === selectedAccountId ? catalogBrands : [];
    let names = [...new Set([...cachedAccountBrands, ...currentSnapshotBrands, ...currentRowBrands])];
    // BRAND-SCOPE (defense-in-depth; the server is the security boundary). All three sources above are ALREADY scoped
    // to the SELECTED account (cachedBrandsForAccount filters by ids=account; rows/catalog are this account's own
    // payload), so a brand from an unauthorized account cannot appear here. For a SELECTED_BRANDS account we still
    // filter to the granted brands (the account has more brands than granted). For a non-admin ALL_BRANDS account we
    // do NOT filter: every brand belonging to this authorized account is permitted, and filtering by a possibly-stale
    // server permitted set could transiently hide a brand-new brand. The server still projects every payload + 403s a
    // forbidden request.
    const selGrant = access.accountGrants && access.accountGrants[selectedAccountId];
    const singleAccountPermitted = selGrant && selGrant.mode === "SELECTED_BRANDS"
      ? permittedBrandKeySetForAccount(access, selectedAccountId) : null;
    names = filterBrandNamesToPermitted(names, singleAccountPermitted);
    return names.sort((a, b) => a.localeCompare(b));
  }, [cachedAccountBrands, catalogBrands, catalogBrandsAccountId, rows, selectedAccountId, access]);
  // BRAND-SCOPE (frontend UX; the server is the security boundary): is the selected account brand-limited for this
  // user? The served brand list is ALREADY projected to permitted brands server-side, so this only drives the label
  // + single-brand auto-select.
  const brandRestricted = useMemo(() => {
    if (isAdmin || !selectedAccountId) return false;
    const g = access.accountGrants && access.accountGrants[selectedAccountId];
    return !!(g && g.mode === "SELECTED_BRANDS");
  }, [isAdmin, selectedAccountId, access.accountGrants]);
  // If exactly one brand is permitted, auto-select it (the mission's single-permitted-brand rule).
  useEffect(() => {
    if (brandRestricted && brandList.length === 1 && selectedBrand === "ALL") setSelectedBrand(brandList[0]);
  }, [brandRestricted, brandList, selectedBrand]);
  const portfolioBrandList = useMemo(() => {
    // The server-projected brand-directory (brandDirectoryBrands) is already limited to the user's permitted brands
    // across their accounts. The per-account localStorage caches, however, are NOT re-projected, so filter each
    // account's contribution to THAT account's permitted keys (null = unrestricted -> unchanged).
    const names = new Set(brandDirectoryBrands);
    accounts.forEach((account) => {
      const permitted = permittedBrandKeySetForAccount(access, account.id);
      filterBrandNamesToPermitted(cachedBrandsForAccount(account.id), permitted).forEach((brand) => names.add(brand));
    });
    if (selectedPortfolioBrand) names.add(selectedPortfolioBrand);
    // Defense-in-depth: when EVERY in-scope account is brand-restricted (no admin, no ALL_BRANDS account), the
    // portfolio selector can only legitimately offer the UNION of permitted brands -- constrain it so a stale
    // directory cache or a previously-selected forbidden brand can never surface. If ANY account is unrestricted the
    // portfolio may legitimately span all brands those accounts sell, so no union constraint is applied.
    let out = [...names];
    if (!isAdmin && accounts.length) {
      const unionKeys = new Set();
      let anyUnrestricted = false;
      for (const account of accounts) {
        const permitted = permittedBrandKeySetForAccount(access, account.id);
        if (!permitted) { anyUnrestricted = true; break; }
        permitted.forEach((k) => unionKeys.add(k));
      }
      if (!anyUnrestricted) out = out.filter((b) => unionKeys.has(canonicalBrandKey(b)));
    }
    return out.sort((a, b) => a.localeCompare(b));
  }, [accounts, selectedPortfolioBrand, brandDirectoryBrands, brandDirectoryVersion, rows, access, isAdmin]);
  function filterRows(from, to) {
    return brandRows.filter((r) => r.date >= from && r.date <= to);
  }
  function compareValue(curFrom, curTo, prevFrom, prevTo, minDate) {
    if (!minDate || prevFrom < minDate) return { value: null, insufficient: true, curr: null };
    const curAgg = aggregate(filterRows(curFrom, curTo));
    const prevAgg = aggregate(filterRows(prevFrom, prevTo));
    return { value: pct(curAgg.sales, prevAgg.sales), insufficient: false, curr: curAgg.sales };
  }

  const comparisons = useMemo(() => {
    if (!scopeMax) return null;
    const prevDay = addDays(latest, -1);
    const dod = compareValue(latest, latest, prevDay, prevDay, scopeMin);
    const wow = compareValue(addDays(latest, -6), latest, addDays(latest, -13), addDays(latest, -7), scopeMin);
    const pm = shiftMonthRange(latest, 0, -1);
    const mtd = compareValue(monthStart(latest), latest, pm.start, pm.end, scopeMin);
    const py = shiftMonthRange(latest, -1, 0);
    const yoy = compareValue(monthStart(latest), latest, py.start, py.end, scopeMin);
    return { dod, wow, mtd, yoy };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandRows, latest, scopeMin]);

  const [rangeFrom, rangeTo] = useMemo(() => {
    let f, t;
    switch (rangePreset) {
      case "YESTERDAY": {
        // Use the prior calendar day when it is available; a delayed source
        // falls back to its latest completed date instead of creating an
        // inverted range.
        const yesterday = addDays(TODAY, -1);
        f = yesterday <= latest ? yesterday : latest;
        t = f;
        break;
      }
      case "7D": f = addDays(latest, -6); t = latest; break;
      case "90D": f = addDays(latest, -89); t = latest; break;
      case "MTD": f = monthStart(latest); t = latest; break;
      case "YTD": f = yearStart(latest); t = latest; break;
      case "CUSTOM": f = customFrom || scopeMin || latest; t = customTo || latest; break;
      default: f = addDays(latest, -29); t = latest;
    }
    if (scopeMin && f < scopeMin) f = scopeMin;
    if (t > latest) t = latest;
    return [f, t];
  }, [rangePreset, latest, scopeMin, customFrom, customTo]);

  const scopedRows = useMemo(() => filterRows(rangeFrom, rangeTo), [brandRows, rangeFrom, rangeTo]);
  const kpi = useMemo(() => aggregate(scopedRows), [scopedRows]);
  const aov = kpi.orders > 0 ? kpi.sales / kpi.orders : 0;
  // Explicit-zero units, SCOPED to the selected date range (the server returned the wide-window, brand-attributed
  // breakdown; filtering to [rangeFrom, rangeTo] here keeps the count in step with the date filter without a
  // re-fetch). This is a SEPARATE audit indicator -- it never feeds kpi/Sales/Units.
  const [showExplicitZero, setShowExplicitZero] = useState(false);
  const explicitZeroScoped = useMemo(() => {
    const avail = oliQuality && oliQuality.available !== false;
    const inRange = (avail ? (oliQuality.breakdown || []) : []).filter((b) => b && b.date >= rangeFrom && b.date <= rangeTo);
    return {
      unavailable: !!(oliQuality && oliQuality.available === false),
      units: inRange.reduce((s, b) => s + (Number(b.units) || 0), 0),
      rows: inRange.reduce((s, b) => s + (Number(b.rows) || 0), 0),
      breakdown: inRange,
    };
  }, [oliQuality, rangeFrom, rangeTo]);
  // The Order Line Items sales source carries item_price_value (sales) + quantity (units) but no
  // order-count column, so Orders / AOV show "—" unless an orders figure is actually present on the rows.
  const hasOrders = useMemo(() => brandRows.some((r) => r.total_orders !== undefined && r.total_orders !== null), [brandRows]);

  /* Period-over-period change for the selected range, measured against the
     immediately preceding window of the same length.

     It is deliberately withheld (null) when that earlier window starts before
     the first date this scope actually has data for: comparing against a period
     the source never reported would invent a change. Nothing here is a
     forecast — every figure is summed from the same cached rows the KPIs use. */
  const kpiDeltas = useMemo(() => {
    if (!scopeMax || !scopeMin) return null;
    const spanDays = Math.round((toUTC(rangeTo) - toUTC(rangeFrom)) / 86400000) + 1;
    if (spanDays < 1) return null;
    const prevTo = addDays(rangeFrom, -1);
    const prevFrom = addDays(prevTo, -(spanDays - 1));
    if (prevFrom < scopeMin) return null;
    const prev = aggregate(filterRows(prevFrom, prevTo));
    const prevAov = prev.orders > 0 ? prev.sales / prev.orders : null;
    return {
      from: prevFrom,
      to: prevTo,
      label: fmtRangeLabel(prevFrom, prevTo),
      sales: pct(kpi.sales, prev.sales),
      units: pct(kpi.units, prev.units),
      orders: prev.orders > 0 ? pct(kpi.orders, prev.orders) : null,
      aov: prevAov !== null ? pct(aov, prevAov) : null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandRows, rangeFrom, rangeTo, scopeMin, scopeMax, kpi, aov]);

  /* Daily series behind the KPI sparklines. These are the real per-day sums for
     the selected range; Sparkline itself renders nothing below three points, so
     a short range simply has no sparkline rather than a fabricated one. */
  const kpiSpark = useMemo(() => {
    const byDate = new Map();
    scopedRows.forEach((r) => {
      const bucket = byDate.get(r.date) || { sales: 0, units: 0, orders: 0 };
      bucket.sales += salesInDisplay(r);
      bucket.units += r.total_units_sold || 0;
      bucket.orders += r.total_orders || 0;
      byDate.set(r.date, bucket);
    });
    const dates = [...byDate.keys()].sort();
    const series = dates.map((date) => byDate.get(date));
    return {
      sales: series.map((bucket) => bucket.sales),
      units: series.map((bucket) => bucket.units),
      orders: series.map((bucket) => bucket.orders),
      aov: series.map((bucket) => (bucket.orders > 0 ? bucket.sales / bucket.orders : null)).filter((value) => value !== null),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedRows]);

  const trend = useMemo(() => {
    const buckets = {};
    scopedRows.forEach((r) => {
      const v = salesInDisplay(r);
      let key;
      if (granularity === "M") key = r.date.slice(0, 7);
      else if (granularity === "W") key = weekStart(r.date);
      else key = r.date;
      // Units and orders ride along on the same bucket so the chart tooltip can
      // show them when — and only when — the source actually supplied them.
      const bucket = buckets[key] || {
        value: 0, units: 0, orders: 0, hasUnits: false, hasOrders: false,
      };
      bucket.value += v;
      if (r.total_units_sold !== undefined && r.total_units_sold !== null) {
        bucket.units += r.total_units_sold || 0;
        bucket.hasUnits = true;
      }
      if (r.total_orders !== undefined && r.total_orders !== null) {
        bucket.orders += r.total_orders || 0;
        bucket.hasOrders = true;
      }
      buckets[key] = bucket;
    });
    return Object.keys(buckets).sort().map((k) => {
      let label;
      if (granularity === "M") { const [y, m] = k.split("-"); label = `${MONTH_ABBR[+m - 1]} ${y}`; }
      else { const p = parts(k); label = `${MONTH_ABBR[p.m - 1]} ${p.d}`; }
      return { key: k, label, ...buckets[k] };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedRows, granularity]);

  const byAccountBreakdown = useMemo(() => {
    const sums = {};
    scopedRows.forEach((r) => {
      const v = salesInDisplay(r);
      sums[r.seller_or_vendor_id] = (sums[r.seller_or_vendor_id] || 0) + v;
    });
    const total = Object.values(sums).reduce((a, b) => a + b, 0);
    return Object.keys(sums).map((id) => {
      const a = accountById[id];
      return { key: id, label: a?.name || id, flag: a ? FLAGS[a.country] : null, value: sums[id], share: total ? (sums[id] / total) * 100 : 0 };
    }).sort((a, b) => b.value - a.value);
  }, [scopedRows, accountById]);

  const byBrandBreakdown = useMemo(() => {
    const sums = {};
    scopedRows.forEach((r) => {
      const b = productBrand(r);
      const v = salesInDisplay(r);
      sums[b] = (sums[b] || 0) + v;
    });
    const total = Object.values(sums).reduce((a, b) => a + b, 0);
    return Object.keys(sums).map((b) => ({ key: b, label: b, flag: null, value: sums[b], share: total ? (sums[b] / total) * 100 : 0 })).sort((a, b) => b.value - a.value);
  }, [scopedRows]);

  const activeAccountKeys = useMemo(() => new Set(selectedAccountId ? [selectedAccountId] : []), [selectedAccountId]);
  const activeBrandKeys = useMemo(() => {
    return selectedBrand === "ALL" ? new Set() : new Set([selectedBrand]);
  }, [selectedBrand]);
  // Whether the selected scope actually has sales rows inside the selected
  // range. This separates "nothing saved yet" from "saved, but no sales here",
  // which are two different states and get two different screens.
  const hasDashboardData = scopedRows.length > 0;

  if (!isAdmin && access.accountIds.length === 0) {
    return <div className="dash-root"><style>{STYLE}</style><div className="loading-screen"><ShieldCheck size={24} style={{ marginBottom: 10 }} /><strong>No Amazon accounts assigned</strong><div style={{ marginTop: 8 }}>Your administrator must assign an account before you can view dashboard data.</div><button className="cache-refresh-btn" onClick={onSignOut}><LogOut size={14} />Sign out</button></div></div>;
  }

  if (accountsLoading) {
    return <div className="dash-root"><style>{STYLE}</style><div className="loading-screen">Loading your Amazon accounts…</div></div>;
  }
  if (accountsError) {
    return (
      <div className="dash-root">
        <style>{STYLE}</style>
        <div className="loading-screen">
          <AlertTriangle size={20} style={{ marginBottom: 8 }} />
          <div>{accountsError}</div>
          <div style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 8 }}>
            The dashboard loads the latest saved data automatically. Reports never call DataDoe on open.
          </div>
          <button className="cache-refresh-btn" onClick={fetchAccounts} disabled={accountsLoading}>
            <RefreshCw size={14} className={accountsLoading ? "spin" : ""} />
            Retry loading accounts
          </button>
        </div>
      </div>
    );
  }

  /* ===== The header Reload control =====
     One button drives every view. It now RELOADS the latest saved data (read-only)
     and never calls DataDoe -- DataDoe refreshes are owned by Scheduler-v2 and by
     explicit admin syncs in the Data Sync Center. This descriptor keeps the routing
     in one place. The Priority Feed owns no data of its own and updates from the six
     saved reports, so it is deliberately not reloadable from here. */
  const showingBrandPortfolio = view === "dashboard" && dashboardMode === "brand";
  const activeStamp = onFeed ? null
    : showingBrandPortfolio ? brandDirectoryFetchedAt
    : activeInsightReport ? activeInsightReport.cachedAt
    : view === "fbaplan" ? planCachedAt
    : view === "reconciliation" ? reconciliationCachedAt
    : view === "skupl" ? skuPlCachedAt
    : view === "keywordrank" ? keywordRankCachedAt
    : view === "contentchanges" ? contentChangesCachedAt
    : view === "skumovement" ? skuMovement.cachedAt
    : lastFetchedAt;
  const activeBusy = showingBrandPortfolio ? brandDirectoryLoading
    : activeInsightReport ? activeInsightReport.loading
    : view === "daily" ? dailyLoading
    : view === "fbaplan" ? planLoading
    : view === "reconciliation" ? reconciliationLoading
    : view === "skupl" ? skuPlLoading
    : view === "keywordrank" ? keywordRankLoading
    : view === "contentchanges" ? contentChangesLoading
    : view === "skumovement" ? (skuMovement.loading || skuMovement.updating)
    : rowsLoading;
  const accountLabel = refreshScopeAccount?.name || "selected account";
  const refreshScopeLabel = showingBrandPortfolio ? (selectedPortfolioBrand || "portfolio brand") : accountLabel;
  const refreshDescriptor = {
    // In portfolio mode this button refreshes the BRAND LIST only. Rebuilding
    // the report itself is the Refresh inside the Brand View page, so the two
    // actions stay distinct instead of one button meaning two things.
    label: onFeed ? "Combined feed" : activeInsightReport ? "Shared snapshot" : showingBrandPortfolio ? "Brand directory" : "Last updated",
    value: onFeed
      ? accountLabel
      : activeBusy
        ? "Updating…"
        : activeStamp
          ? `${activeStamp.toLocaleTimeString()} · ${refreshScopeLabel}`
          : showingBrandPortfolio ? "Not yet loaded" : selectedAccountId ? "Not yet loaded" : "Select an account",
    live: Boolean(activeStamp) || onFeed,
    busy: activeBusy,
    // READ-ONLY reload: re-reads the latest saved snapshot (self-healing for Daily). It NEVER calls DataDoe or
    // spends a token -- scheduled refreshes are owned by Scheduler-v2 and explicit admin syncs in the Data Sync
    // Center. Every report page routes to its cache-first loader; the brand directory reloads the brand list.
    onRefresh: onFeed ? undefined
      : showingBrandPortfolio ? fetchBrandDirectory
      : activeInsightReport ? activeInsightReport.reload
      : view === "daily" ? loadCachedDaily
      : view === "fbaplan" ? loadCachedPlan
      : view === "reconciliation" ? loadCachedReconciliation
      : view === "skupl" ? loadCachedSkuPl
      : view === "keywordrank" ? loadCachedKeywordRank
      : view === "contentchanges" ? loadCachedContentChanges
      : view === "skumovement" ? skuMovement.reload
      : loadCachedRows,
    disabled: onFeed || (showingBrandPortfolio && !accounts.length && !isAdmin && !allowedAccountIds.size),
    hint: onFeed
      ? "The Priority Feed combines the six saved reports. Each updates automatically from its saved data."
      : showingBrandPortfolio
        ? "Reload the portfolio brand list from the accounts you may access."
        : "Reload the latest saved data. This never calls DataDoe — refreshes run automatically on schedule or from the Data Sync Center.",
  };

  // Brand View owns its own account/brand/date/currency control bar, so the
  // global scope cluster is hidden there rather than showing two account
  // pickers that could disagree. Every other view keeps its existing header.
  const showGlobalScope = view !== "access" && view !== "sync-center" && view !== "brandview";

  return (
    <div className="dash-root">
      <style>{STYLE}</style>

      <div className="app-shell">
        <Sidebar
          view={view}
          onNavigate={(next) => { setView(next); setDashboardMode("account"); setMobileOpen(false); }}
          isAdmin={isAdmin}
          email={access.email}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((value) => !value)}
          mobileOpen={mobileOpen}
          onCloseMobile={() => setMobileOpen(false)}
          onSignOut={onSignOut}
          brandMode={view === "dashboard" && dashboardMode === "brand"}
        />

        {mobileOpen && <div className="sb-backdrop" onClick={() => setMobileOpen(false)} />}

        <div className={"main-area"
          + (view === "dashboard" && dashboardMode === "account" ? " dash-workspace" : "")
          + ((view === "brandview" || view === "daily" || view === "returns" || view === "fbaplan" || view === "skumovement" || view === "campaign-ads" || (view === "dashboard" && dashboardMode === "brand")) ? " op-workspace" : "")}>
          {/* Isolated fluid-motion background, only behind the account Dashboard.
              It self-disables under reduced motion / low-power / no-WebGL and
              falls back to the static CSS wash, so nothing here can block or
              alter the data render. */}
          {view === "dashboard" && dashboardMode === "account" && <WaterBackground />}
          <TopBar
            viewTitle={VIEW_TITLES[view] || "Dashboard"}
            onOpenMenu={() => setMobileOpen(true)}
            mobileOpen={mobileOpen}
            showScope={showGlobalScope}
            accounts={accounts}
            selectedAccountId={selectedAccountId}
            onAccountChange={(id) => { setSelectedAccountId(id); setSelectedBrand("ALL"); }}
            onRefreshAccounts={fetchAccounts}
            accountsRefreshing={accountsLoading}
            brands={view === "fbaplan" ? planBrandOptions : brandList}
            selectedBrand={selectedBrand}
            onBrandChange={setSelectedBrand}
            brandAllLabel={brandRestricted ? "All permitted brands" : "All brands"}
            dashboardMode={view === "dashboard" ? dashboardMode : "account"}
            onDashboardModeChange={view === "dashboard" ? setDashboardMode : undefined}
            portfolioBrands={portfolioBrandList}
            selectedPortfolioBrand={selectedPortfolioBrand}
            onPortfolioBrandChange={setSelectedPortfolioBrand}
            flags={FLAGS}
            refresh={refreshDescriptor}
          />

      {view === "access" && isAdmin && <AccessPanel accessToken={session.access_token} accounts={accounts} onLoadAccounts={fetchAccounts} />}

      {view === "sync-center" && isAdmin && <DataSyncCenter accessToken={session.access_token} />}

      {view === "brandview" && (
        <BrandView
          accounts={accounts}
          accountsLoading={accountsLoading}
          accountsError={accountsError}
          loadReport={loadSharedReport}
          refreshReport={refreshSharedReport}
        />
      )}

      {view === "dashboard" && (dashboardMode === "brand" ? (
        <BrandPortfolio
          brand={selectedPortfolioBrand}
          accountIds={portfolioAccountIds}
          accountsKnown={portfolioScopeResolved}
          loadReport={loadSharedReport}
          refreshReport={refreshSharedReport}
          directoryLoading={brandDirectoryLoading}
          directoryError={brandDirectoryError}
          onLoadBrandDirectory={fetchBrandDirectory}
          isAdmin={isAdmin}
          sourceAccounts={portfolioSourceAccounts}
        />
      ) : (
      <div className="container dashboard-page">
        <div className="page-head">
          <div>
            <div className="page-title">Sales Dashboard</div>
            <div className="page-sub">
              {refreshScopeAccount?.name || "No account selected"}
              {selectedBrand === "ALL" ? " · All brands" : ` · ${selectedBrand}`}
              {selectedMarketplace.country ? ` · ${selectedMarketplace.country}` : ""}
              {` · reported in ${displayCurrency}`}
            </div>
          </div>
        </div>

        {/* Two-layer PROVISIONAL/FINAL D-1 on the Sales Dashboard: covered-through vs latest-itemized are distinct.
            The real itemized sales are shown; pending is counted separately; a 0%-itemized D-1 shows no fabricated
            zero row -- the sales simply end at the latest itemized date while the badge says the D-1 is provisional. */}
        {salesCompleteness && (
          <div className="page-sub" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <span style={{ padding: "1px 8px", borderRadius: 10, fontSize: 11, fontWeight: 700,
              background: salesCompleteness.provisional ? "rgba(210,140,0,0.14)" : (salesCompleteness.sourceDefect ? "rgba(200,50,50,0.14)" : "rgba(30,150,80,0.14)"),
              color: salesCompleteness.provisional ? "#a86a00" : (salesCompleteness.sourceDefect ? "#b32424" : "#1a7f45") }}>
              {salesCompleteness.provisional ? "Provisional D-1" : (salesCompleteness.sourceDefect ? "Source issue" : "Final D-1")}
            </span>
            <span>Covered through {fmtDateHuman(salesCompleteness.latestDate)}
              {salesCompleteness.provisional ? ` · ${salesCompleteness.itemizationPercent}% itemized · ${salesCompleteness.pendingOrderCount} orders pending` : ""}
              {salesCompleteness.finalizedThrough ? ` · finalized through ${fmtDateHuman(salesCompleteness.finalizedThrough)}` : ""}</span>
          </div>
        )}
        {salesCompleteness && salesCompleteness.provisional && (
          <DataQualityAlert tone="info" title={`Provisional D-1 (${fmtDateHuman(salesCompleteness.latestDate)}) — ${salesCompleteness.itemizationPercent}% of orders itemized`}
            detail={`${salesCompleteness.notice} (${salesCompleteness.pendingOrderCount} order(s), ${salesCompleteness.pendingUnitCount} unit(s) pending item-level prices; sales shown are through the latest itemized date.)`} />
        )}
        {salesCompleteness && salesCompleteness.sourceDefect && (
          <DataQualityAlert tone="error" title="Source-data issue for D-1" detail={salesCompleteness.notice} />
        )}
        {salesCompleteness && salesCompleteness.unitBreakdown && <ObservedUnitsBreakdown completeness={salesCompleteness} />}

        {/* Global date filter. Presets, the custom range and its clamping are
            the app's existing logic; only the control's presentation changed. */}
        <DateRangeSelector
          preset={rangePreset}
          onPresetChange={setRangePreset}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFrom={setCustomFrom}
          onCustomTo={setCustomTo}
          minDate={scopeMin}
          maxDate={latest}
          rangeLabel={hasDashboardData ? fmtRangeLabel(rangeFrom, rangeTo) : null}
          icon={<CalendarRange size={13} aria-hidden="true" />}
        />

        {rowsError && (
          <DataQualityAlert
            tone="error"
            title="The dashboard data could not be refreshed"
            detail={rowsError}
          />
        )}
        {/* TYPED data-quality warning: shown ONLY for non-cancelled units whose order value is genuinely
            NULL/missing upstream (missing_order_value_units) -- NOT for cancelled orders and NOT for present-zero
            promotional/replacement/free units, which are excluded from Total Sales and Units Sold by policy and
            are never a defect. A legacy snapshot carrying only `unpriced_units` yields 0 here, so the old banner
            can never resurface. */}
        {!rowsLoading && selectedBrand === "ALL" && kpi.missingOrderValueUnits > 0 && (
          <DataQualityAlert
            tone="warning"
            title={`${kpi.missingOrderValueUnits.toLocaleString("en-US")} unit${kpi.missingOrderValueUnits === 1 ? "" : "s"} in this range have no order value`}
            detail="These units are excluded from Total Sales and Units Sold. Refresh again once DataDoe completes its upstream order data — no value is estimated or filled in here."
          />
        )}

        {/* SEPARATE, informational (amber) data-quality notice: non-cancelled units whose order value is EXPLICITLY
            present and numerically 0 (may be promotional / replacement / free / incomplete). Excluded from Total
            Sales and Units Sold; never labelled as definitely-missing sales. Scoped to the selected account, date
            range, and brand (Catalog-attributed). A separate class from the "no order value" (NULL) warning above. */}
        {!rowsLoading && !explicitZeroScoped.unavailable && explicitZeroScoped.units > 0 && (
          <DataQualityAlert
            tone="warning"
            title={`${explicitZeroScoped.units.toLocaleString("en-US")} non-cancelled unit${explicitZeroScoped.units === 1 ? "" : "s"} have an explicit ${fmtMoney(0, displayCurrency)} order value`}
            detail={(
              <>
                These units are excluded from Total Sales and Units Sold. They may be promotional, replacement, free, or incomplete upstream records. Review the breakdown before treating them as a sales gap.{" "}
                <button
                  type="button"
                  onClick={() => setShowExplicitZero((v) => !v)}
                  style={{ background: "none", border: "none", padding: 0, color: "inherit", textDecoration: "underline", cursor: "pointer", font: "inherit" }}
                >
                  {showExplicitZero ? "Hide breakdown" : `Show breakdown (${explicitZeroScoped.breakdown.length.toLocaleString("en-US")})`}
                </button>
              </>
            )}
          />
        )}
        {!rowsLoading && showExplicitZero && !explicitZeroScoped.unavailable && explicitZeroScoped.breakdown.length > 0 && (
          <div className="panel" style={{ overflowX: "auto", marginTop: 6 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
              <thead>
                <tr style={{ textAlign: "left", opacity: 0.75 }}>
                  <th style={{ padding: "4px 8px" }}>Date</th><th style={{ padding: "4px 8px" }}>SKU</th><th style={{ padding: "4px 8px" }}>Child ASIN</th>
                  <th style={{ padding: "4px 8px" }}>Status</th><th style={{ padding: "4px 8px" }}>Fulfilment</th><th style={{ padding: "4px 8px" }}>State</th><th style={{ padding: "4px 8px" }}>City</th>
                  <th style={{ padding: "4px 8px" }}>Order ID</th>
                  <th style={{ padding: "4px 8px", textAlign: "right" }}>Rows</th><th style={{ padding: "4px 8px", textAlign: "right" }}>Units</th>
                </tr>
              </thead>
              <tbody>
                {explicitZeroScoped.breakdown.slice(0, 300).map((b, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--border, #eee)" }}>
                    <td style={{ padding: "4px 8px" }}>{b.date}</td><td style={{ padding: "4px 8px" }}>{b.sku || "—"}</td><td style={{ padding: "4px 8px" }}>{b.childAsin || "—"}</td>
                    <td style={{ padding: "4px 8px" }}>{b.status || "—"}</td><td style={{ padding: "4px 8px" }}>{b.fulfillment || "—"}</td><td style={{ padding: "4px 8px" }}>{b.state || "—"}</td><td style={{ padding: "4px 8px" }}>{b.city || "—"}</td>
                    <td style={{ padding: "4px 8px", maxWidth: 230 }}>
                      {!b.hasAudit ? (
                        <span style={{ opacity: 0.55 }}>Not captured — before Order ID tracking</span>
                      ) : (b.orderIds && b.orderIds.some((o) => o.orderIdAvailable)) ? (
                        <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
                          {b.orderIds.filter((o) => o.orderIdAvailable).map((o, j) => (
                            <button key={j} type="button" title="Copy Amazon Order ID"
                              onClick={() => { try { navigator.clipboard && navigator.clipboard.writeText(o.orderId); } catch (_e) { /* clipboard unavailable */ } }}
                              style={{ fontFamily: "monospace", fontSize: "0.78rem", border: "1px solid var(--border, #ddd)", borderRadius: 4, padding: "1px 5px", background: "transparent", cursor: "pointer" }}>
                              {o.orderId}
                            </button>
                          ))}
                        </span>
                      ) : (
                        <span style={{ opacity: 0.55 }}>Order ID unavailable from source</span>
                      )}
                    </td>
                    <td style={{ padding: "4px 8px", textAlign: "right" }}>{b.rows.toLocaleString("en-US")}</td><td style={{ padding: "4px 8px", textAlign: "right" }}>{b.units.toLocaleString("en-US")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {explicitZeroScoped.breakdown.length > 300 && (
              <div style={{ padding: "6px 8px", opacity: 0.7 }}>Showing the first 300 of {explicitZeroScoped.breakdown.length.toLocaleString("en-US")} grains.</div>
            )}
          </div>
        )}
        {!rowsLoading && explicitZeroScoped.unavailable && (
          <div className="alert-detail" style={{ opacity: 0.7, fontSize: "0.82rem", padding: "2px 4px" }}>OLI quality details are temporarily unavailable — business totals are unaffected.</div>
        )}

        {!selectedAccountId ? (
          <div className="panel">
            <EmptyState
              icon={<Inbox size={19} aria-hidden="true" />}
              title="No account selected"
              actions={accounts.length ? null : (
                <button className="plan-export-btn" type="button" onClick={fetchAccounts} disabled={accountsLoading}>
                  <RefreshCw size={14} className={accountsLoading ? "spin" : ""} aria-hidden="true" />
                  Load account directory
                </button>
              )}
            >
              Choose an Amazon account in the command bar above to load its saved sales data.
            </EmptyState>
          </div>
        ) : rowsLoading && !hasDashboardData ? (
          <>
            <SkeletonMetricGrid count={4} />
            <div className="chart-card"><SkeletonChart /></div>
          </>
        ) : rowsCacheMissing && !hasDashboardData ? (
          <div className="panel">
            <EmptyState
              icon={<DatabaseZap size={19} aria-hidden="true" />}
              title="Waiting for the scheduled data refresh"
              actions={(
                <button className="plan-export-btn" type="button" onClick={loadCachedRows} disabled={rowsLoading}>
                  <RefreshCw size={14} className={rowsLoading ? "spin" : ""} aria-hidden="true" />
                  Reload latest data
                </button>
              )}
            >
              Opening a report, switching account or brand, and changing the date range all read saved data only.
              Refresh is the one action that calls DataDoe.
            </EmptyState>
          </div>
        ) : !hasDashboardData ? (
          <div className="panel">
            <EmptyState icon={<Inbox size={19} aria-hidden="true" />} title="No sales in this range">
              This account has saved data, but no sales were reported between {fmtRangeLabel(rangeFrom, rangeTo)}.
              Widen the date range or clear the brand filter.
            </EmptyState>
          </div>
        ) : (
        <>
          {/* Primary KPI section. Comparisons and sparklines appear only where
              real history exists for this scope; nothing is back-filled.
              The grid is deliberately NOT keyed by scope/date: a stable identity
              lets React reconcile the cards in place so the value and its matching
              date label swap together in ONE atomic render — no unmount, no
              entrance-animation replay, no full-KPI-row flash on a filter change.
              The entrance animation therefore runs only once, when the Dashboard
              route first mounts. */}
          <div className="metric-grid">
            <MetricCard
              label="Total Sales"
              variant="hero"
              value={fmtMoney(kpi.sales, displayCurrency)}
              hint={`Order value in ${displayCurrency}. Currencies are never converted or combined.`}
              period={fmtRangeLabel(rangeFrom, rangeTo)}
              trend={kpiDeltas ? <TrendIndicator value={kpiDeltas.sales} text={fmtPct(kpiDeltas.sales)} title={`vs ${kpiDeltas.label}`} /> : null}
              spark={<Sparkline values={kpiSpark.sales} color={DASH_CHART.primary} ariaLabel="Daily sales for the selected range" />}
            />
            <MetricCard
              label="Units Sold"
              icon={<Boxes size={15} />}
              value={kpi.units.toLocaleString("en-US")}
              period={fmtRangeLabel(rangeFrom, rangeTo)}
              trend={kpiDeltas ? <TrendIndicator value={kpiDeltas.units} text={fmtPct(kpiDeltas.units)} title={`vs ${kpiDeltas.label}`} /> : null}
              spark={<Sparkline values={kpiSpark.units} color={DASH_CHART.teal} ariaLabel="Daily units for the selected range" />}
            />
            <MetricCard
              label="Orders"
              icon={<ReceiptText size={15} />}
              value={hasOrders ? kpi.orders.toLocaleString("en-US") : "—"}
              hint={hasOrders ? undefined : "This sales source reports no order count, so Orders and Average Order Value are unavailable rather than shown as zero."}
              period={fmtRangeLabel(rangeFrom, rangeTo)}
              trend={hasOrders && kpiDeltas && kpiDeltas.orders !== null ? <TrendIndicator value={kpiDeltas.orders} text={fmtPct(kpiDeltas.orders)} title={`vs ${kpiDeltas.label}`} /> : null}
              spark={hasOrders ? <Sparkline values={kpiSpark.orders} color={DASH_CHART.orders} ariaLabel="Daily orders for the selected range" /> : null}
            />
            <MetricCard
              label="Avg. Order Value"
              icon={<Wallet size={15} />}
              value={hasOrders ? fmtMoney(aov, displayCurrency, 2) : "—"}
              hint={hasOrders ? "Total sales divided by orders for the selected range." : "Requires an order count, which this sales source does not report."}
              period={fmtRangeLabel(rangeFrom, rangeTo)}
              trend={hasOrders && kpiDeltas && kpiDeltas.aov !== null ? <TrendIndicator value={kpiDeltas.aov} text={fmtPct(kpiDeltas.aov)} title={`vs ${kpiDeltas.label}`} /> : null}
              spark={hasOrders ? <Sparkline values={kpiSpark.aov} color={DASH_CHART.gold} ariaLabel="Daily average order value for the selected range" /> : null}
            />
          </div>

          {/* Performance comparisons. Each one states its own basis and shows an
              em dash when this account has too little history to compare. Stable
              identity (no scope/date key) so the row updates in place without a
              remount or entrance-animation replay on a filter change. */}
          <div className="cmp-grid">
            <ComparisonMetric label="Day over Day" basis="vs previous day" data={comparisons?.dod} format={fmtPct} />
            <ComparisonMetric label="Week over Week" basis="vs prior 7 days" data={comparisons?.wow} format={fmtPct} />
            <ComparisonMetric label="Month to Date" basis="vs last month, same days" data={comparisons?.mtd} format={fmtPct} />
            <ComparisonMetric label="Year over Year" basis="vs same period last year" data={comparisons?.yoy} format={fmtPct} />
          </div>

          <ChartCard
            title="Sales Trend"
            subtitle={`${trend.length.toLocaleString("en-US")} ${granularity === "M" ? "month" : granularity === "W" ? "week" : "day"}${trend.length === 1 ? "" : "s"} · ${fmtRangeLabel(rangeFrom, rangeTo)} · ${displayCurrency}`}
            actions={(
              <SegmentedControl
                ariaLabel="Trend granularity"
                size="sm"
                value={granularity}
                onChange={setGranularity}
                options={[
                  { value: "D", label: "Daily" },
                  { value: "W", label: "Weekly" },
                  { value: "M", label: "Monthly" },
                ]}
              />
            )}
          >
            {trend.length === 0 ? (
              <EmptyState icon={<BarChart3 size={19} aria-hidden="true" />} title="Nothing to plot">
                No sales were reported in this range, so the chart is intentionally left empty rather than drawn at zero.
              </EmptyState>
            ) : (
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trend} margin={{ top: 8, right: 18, left: 6, bottom: 0 }}>
                    <defs>
                      <linearGradient id="fillSales" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={DASH_CHART.primary} stopOpacity={0.20} />
                        <stop offset="100%" stopColor={DASH_CHART.primary} stopOpacity={0.01} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={DASH_CHART.grid} vertical={false} />
                    <XAxis
                      dataKey="label" tick={{ fontSize: 10.5, fill: DASH_CHART.axis }}
                      axisLine={{ stroke: DASH_CHART.axisLine }} tickLine={false}
                      minTickGap={18} tickMargin={8}
                    />
                    <YAxis
                      tick={{ fontSize: 10.5, fill: DASH_CHART.axis }} axisLine={false} tickLine={false}
                      tickFormatter={(value) => compactNumber(value, displayCurrency)} width={56}
                    />
                    <Tooltip
                      cursor={{ stroke: DASH_CHART.axis, strokeWidth: 1, strokeDasharray: "3 3" }}
                      content={(props) => (
                        <ChartTooltip
                          {...props}
                          rows={(point) => [
                            { key: "sales", label: "Sales", value: fmtMoney(point.value, displayCurrency), color: DASH_CHART.primary },
                            point.hasUnits ? { key: "units", label: "Units", value: point.units.toLocaleString("en-US") } : null,
                            point.hasOrders ? { key: "orders", label: "Orders", value: point.orders.toLocaleString("en-US") } : null,
                          ]}
                        />
                      )}
                    />
                    <Area
                      type="monotone" dataKey="value" stroke={DASH_CHART.primary} strokeWidth={2}
                      fill="url(#fillSales)" dot={false}
                      activeDot={{ r: 4, fill: DASH_CHART.primary, stroke: "#fff", strokeWidth: 2 }}
                      isAnimationActive={!prefersReducedMotion}
                      animationDuration={180}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </ChartCard>

          <div className={"breakdown-grid" + (byAccountBreakdown.length <= 1 ? " single-account" : "")}>
            <BreakdownCard
              title="Sales by Account"
              subtitle="The selected account is highlighted"
              items={byAccountBreakdown}
              activeKeys={activeAccountKeys}
              mutedKeys={EMPTY_KEY_SET}
              formatValue={(value) => fmtMoneyCompact(value, displayCurrency)}
              emptyMessage="No account sales in this range."
            />
            <BreakdownCard
              title="Sales by Brand"
              subtitle="Contribution to the selected range"
              items={byBrandBreakdown}
              palette={DASH_CHART.brandPalette}
              activeKeys={activeBrandKeys}
              formatValue={(value) => fmtMoneyCompact(value, displayCurrency)}
              emptyMessage="No brand sales in this range."
            />
          </div>
        </>
        )}

        <div className="footer-note">
          Total Sales is DataDoe Order Line Items <code>item_price_value</code>, the documented order-value field. Brand filtering uses DataDoe's Product Catalog by ASIN (<code>product_brand</code>) for the selected account. Money is shown in the selected marketplace's currency and is never converted or combined with another currency. Changing account, brand, date range or granularity reads saved data only; <strong>opening or reloading this report never calls DataDoe</strong> — refreshes run automatically on schedule or from the Data Sync Center. Comparisons and sparklines are computed from the same saved rows and are withheld — shown as an em dash or omitted — whenever this account lacks the earlier period they would need. If the warning above appears, DataDoe returned units without an order value; the next scheduled refresh corrects it once its upstream order data is complete.
        </div>
      </div>
      ))}

      {view === "daily" && (
        <DailyReporting
          accountName={refreshScopeAccount?.name}
          selectedBrand={selectedBrand}
          currency={dailyCurrency}
          report={dailyReport}
          rows={dailyRows}
          completeness={dailyCompleteness}
          loading={dailyLoading}
          error={dailyError}
          missing={dailyMissing}
          accountId={selectedAccountId}
          onReload={loadCachedDaily}
          metrics={DAILY_METRICS}
        />
      )}

      {view === "reconciliation" && (
      <div className="container reconciliation-page">
        <div className="controls-bar">
          <div>
            <div className="page-title">Amazon Reconciliation</div>
            <div className="page-sub">Orders versus settlements for {refreshScopeAccount?.name || "the selected account"}{selectedBrand === "ALL" ? "" : ` · ${selectedBrand}`}</div>
          </div>
          {reconciliationData && (
            <div className="recon-month-picker">
              <label htmlFor="reconciliation-month">Report month</label>
              <select id="reconciliation-month" value={reconciliationMonth || "ALL"} onChange={(e) => setReconciliationMonth(e.target.value)}>
                <option value="ALL">All 6 Months</option>
                {(reconciliationData.months || []).map((month) => <option key={month} value={month}>{reconMonthLabel(month)}</option>)}
              </select>
            </div>
          )}
        </div>

        {reconciliationData && reconciliationError && <DataQualityAlert tone="error" title="The last refresh failed" detail={reconciliationError} />}

        {!reconciliationData && (
          <SnapshotGate
            icon={<ReceiptText size={19} aria-hidden="true" />}
            label="reconciliation report"
            error={reconciliationError}
            loading={reconciliationLoading}
            notice={snapshotNotice}
            onRefresh={loadCachedReconciliation}
            busy={reconciliationLoading}
          />
        )}

        {reconciliationData && <>
          <div className="recon-freshness">
            <span className="live-dot" style={{ position: "relative", top: 1 }} />
            <span>Orders and settlement events from <strong>{fmtDateHuman(reconciliationData.from)}</strong> to <strong>{fmtDateHuman(reconciliationData.to)}</strong></span>
            <span className="plan-fresh-sep">·</span>
            <span>cached {reconciliationCachedAt?.toLocaleString()}</span>
          </div>
          {reconciliationScope.brandScopeIsConservative && (
            <div className="recon-notice"><Info size={15} /> Brand scope includes only orders containing this one brand. Mixed-brand orders are excluded because settlement events are order-level and cannot be allocated accurately by product brand.</div>
          )}

          <div className="recon-kpis">
            <ReconKpi label="Shipped Orders" value={reconciliationMetrics.shippedOrders.toLocaleString("en-US")} note="orders in selected order month" />
            <ReconKpi label="Settled Orders" value={reconciliationMetrics.settledOrders.toLocaleString("en-US")} note={`gap ${reconciliationMetrics.orderGap.toLocaleString("en-US")}`} />
            <ReconKpi label="Order Revenue" value={fmtMoney(reconciliationMetrics.orderRevenue, displayCurrency)} note="purchase-date basis" />
            <ReconKpi label="Settled Revenue" value={fmtMoney(reconciliationMetrics.settledRevenue, displayCurrency)} note={`gap ${fmtMoney(reconciliationMetrics.revenueGap, displayCurrency)}`} />
            <ReconKpi label="Refunds" value={`${reconciliationMetrics.refunds.toLocaleString("en-US")} · ${fmtMoney(reconciliationMetrics.refundAmount, displayCurrency)}`} note="orders with a refund event" />
            <ReconKpi label="Cancelled" value={reconciliationMetrics.cancelled.toLocaleString("en-US")} note="not expected to settle" />
            <ReconKpi label="Reconciliation Rate" value={reconciliationMetrics.reconciliationRate === null ? "-" : `${reconciliationMetrics.reconciliationRate.toFixed(1)}%`} note="shipped orders with ORDER settlement" />
            <ReconKpi label="Net Payout" value={fmtMoney(reconciliationMetrics.netPayout, displayCurrency)} note="settlement posted-date basis" />
          </div>

          <div className="recon-chart-grid">
            <div className="panel recon-chart-panel">
              <div className="panel-head"><div><div className="panel-title">Monthly Settlement Trend</div><div className="page-sub">Selected month is highlighted in amber</div></div></div>
              <div className="recon-chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={reconciliationTrend} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                    <CartesianGrid stroke={CHART.grid} vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10.5, fill: CHART.axis }} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 10.5, fill: CHART.axis }} axisLine={false} tickLine={false} />
                    <Tooltip />
                    <Bar dataKey="shipped" name="Shipped orders" radius={[4, 4, 0, 0]}>
                      {reconciliationTrend.map((entry) => <Cell key={entry.month} fill={entry.month === reconciliationMonth ? CHART.gold : CHART.neutral} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="panel recon-chart-panel">
              <div className="panel-head"><div><div className="panel-title">Reconciliation Status</div><div className="page-sub">Order status after matching settlement events</div></div></div>
              <div className="recon-donut-wrap">
                <ResponsiveContainer width="58%" height="100%">
                  <PieChart><Pie data={reconciliationDonut.filter((item) => item.value > 0)} dataKey="value" nameKey="label" innerRadius="56%" outerRadius="78%" paddingAngle={2}>{reconciliationDonut.filter((item) => item.value > 0).map((item) => <Cell key={item.label} fill={item.fill} />)}</Pie><Tooltip /></PieChart>
                </ResponsiveContainer>
                <div className="recon-donut-legend">{reconciliationDonut.map((item) => <div key={item.label}><span style={{ background: item.fill }} />{item.label}<strong>{item.value}</strong></div>)}</div>
              </div>
            </div>
          </div>

          <div className="panel recon-overlay-panel">
            <div className="panel-head">
              <div><div className="panel-title">Order and Settlement Overlay</div><div className="page-sub">Orders use purchase date; settlements use Amazon posting date.</div></div>
              <div className="seg"><button className={reconciliationMode === "counts" ? "active" : ""} onClick={() => setReconciliationMode("counts")}>Order Counts</button><button className={reconciliationMode === "revenue" ? "active" : ""} onClick={() => setReconciliationMode("revenue")}>Revenue</button></div>
            </div>
            <div className="recon-overlay-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={reconciliationDaily} margin={{ top: 10, right: 15, left: -16, bottom: 0 }}>
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10.5, fill: CHART.axis }} axisLine={false} tickLine={false} />
                  <YAxis yAxisId="left" tick={{ fontSize: 10.5, fill: CHART.axis }} axisLine={false} tickLine={false} tickFormatter={(v) => reconciliationMode === "revenue" ? compactNumber(v, displayCurrency) : v} />
                  <YAxis yAxisId="right" orientation="right" allowDecimals={false} tick={{ fontSize: 10.5, fill: CHART.axis }} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(value, name) => [reconciliationMode === "revenue" && name !== "Refund events" ? fmtMoney(value, displayCurrency) : value, name]} />
                  <Legend />
                  <Bar yAxisId="left" dataKey={reconciliationMode === "revenue" ? "orderRevenue" : "shipped"} name={reconciliationMode === "revenue" ? "Order revenue" : "Shipped orders"} fill={CHART.gold} radius={[3, 3, 0, 0]} />
                  <Bar yAxisId="left" dataKey={reconciliationMode === "revenue" ? "settledRevenue" : "settled"} name={reconciliationMode === "revenue" ? "Settled revenue" : "ORDER settlements"} fill={CHART.negative} radius={[3, 3, 0, 0]} />
                  <Line yAxisId="right" type="monotone" dataKey="refunds" name="Refund events" stroke={CHART.info} strokeWidth={2} dot={{ r: 3 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="panel recon-waterfall-panel">
            <div className="panel-head"><div><div className="panel-title">Settlement Revenue Waterfall</div><div className="page-sub">All values preserve the signs supplied by Amazon settlement data.</div></div></div>
            <div className="recon-waterfall">{reconciliationWaterfall.map((item) => <div className="recon-waterfall-row" key={item.label}><span>{item.label}</span><div className="recon-waterfall-track"><div className={`recon-waterfall-fill ${item.kind}`} style={{ width: `${Math.min(100, (Math.abs(item.value) / Math.max(1, ...reconciliationWaterfall.map((bar) => Math.abs(bar.value)))) * 100)}%` }} /></div><strong>{fmtMoney(item.value, displayCurrency, 2)}</strong></div>)}</div>
          </div>

          <div className="panel recon-daily-panel">
            <div className="panel-head"><div><div className="panel-title">Daily Summary</div><div className="page-sub">Click a month above to switch this table together with every dashboard section.</div></div></div>
            <div className="recon-table-scroll"><table className="recon-daily-table"><thead><tr><th>{reconciliationMonth === "ALL" ? "Month" : "Day"}</th><th>Shipped</th><th>ORDER settlements</th><th>Refund events</th><th>Order revenue</th><th>Settled revenue</th></tr></thead><tbody>{reconciliationDaily.map((row) => <tr key={row.key}><td>{row.label}</td><td>{row.shipped}</td><td>{row.settled}</td><td>{row.refunds}</td><td>{fmtMoney(row.orderRevenue, displayCurrency)}</td><td>{fmtMoney(row.settledRevenue, displayCurrency)}</td></tr>)}</tbody></table></div>
          </div>

          <div className="panel recon-explorer-panel">
            <div className="panel-head"><div><div className="panel-title">Order Explorer</div><div className="page-sub">{reconciliationSortedRows.length.toLocaleString("en-US")} matching orders. Copy an order ID, inspect timing, or export the filtered result.</div></div><button className="plan-export-btn" onClick={() => downloadReconciliationCsv(reconciliationSortedRows, displayCurrency, refreshScopeAccount?.name)} disabled={!reconciliationSortedRows.length}><Download size={15} />Download Excel</button></div>
            <div className="recon-filters">
              <label className="plan-field recon-search"><span className="plan-field-label">Search</span><span className="plan-search-wrap"><Search size={14} /><input value={reconciliationSearch} onChange={(e) => setReconciliationSearch(e.target.value)} placeholder="Order ID, status, channel..." /></span></label>
              <ReconSelect label="Order status" value={reconciliationStatusFilter} onChange={setReconciliationStatusFilter} options={["ALL", ...new Set(reconciliationScope.orders.map((order) => String(order.status)))]} />
              <ReconSelect label="Recon status" value={reconciliationReconFilter} onChange={setReconciliationReconFilter} options={["ALL", "Settled", "Settled + Refunded", "Refunded", "Pending", "Cancelled"]} />
              <ReconSelect label="B2B" value={reconciliationB2BFilter} onChange={setReconciliationB2BFilter} options={["ALL", "YES", "NO"]} />
              <ReconSelect label="Cross-month" value={reconciliationCrossMonthFilter} onChange={setReconciliationCrossMonthFilter} options={["ALL", "SAME", "CROSS"]} />
              <label className="plan-field"><span className="plan-field-label">From</span><input type="date" value={reconciliationFrom} min={reconciliationData.from} max={reconciliationData.to} onChange={(e) => setReconciliationFrom(e.target.value)} /></label>
              <label className="plan-field"><span className="plan-field-label">To</span><input type="date" value={reconciliationTo} min={reconciliationData.from} max={reconciliationData.to} onChange={(e) => setReconciliationTo(e.target.value)} /></label>
            </div>
            <div className="recon-table-scroll"><table className="recon-table"><thead><tr><ReconTh label="Order ID" col="orderId" sort={reconciliationSort} setSort={setReconciliationSort} align="left" /><ReconTh label="Order Date" col="orderDate" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Status" col="status" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Channel" col="fulfillmentChannel" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="B2B" col="isBusiness" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Revenue" col="orderRevenue" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Tax" col="orderTax" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Recon Status" col="reconciliationStatus" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Sett. Date" col="settlementDate" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Settled" col="settledRevenue" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Fees" col="fees" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Refund" col="refundAmount" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Net Payout" col="netPayout" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Delta" col="delta" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Cross-Month" col="crossMonth" sort={reconciliationSort} setSort={setReconciliationSort} /></tr></thead><tbody>{reconciliationPageRows.map((row) => <tr key={row.orderId} className={`recon-row-${reconciliationStatusClass(row.reconciliationStatus)}`}><td className="recon-order-id"><button title="Copy order ID" onClick={async () => { try { await navigator.clipboard.writeText(row.orderId); setCopiedOrderId(row.orderId); window.setTimeout(() => setCopiedOrderId(null), 1200); } catch (e) {} }}>{row.orderId} {copiedOrderId === row.orderId ? <Check size={13} /> : <Copy size={13} />}</button></td><td>{row.orderDate}</td><td>{row.status}</td><td>{row.fulfillmentChannel}</td><td>{row.isBusiness ? "Yes" : "No"}</td><td>{fmtMoney(row.orderRevenue, displayCurrency, 2)}</td><td>{fmtMoney(row.orderTax, displayCurrency, 2)}</td><td><span className={`recon-badge ${reconciliationStatusClass(row.reconciliationStatus)}`}>{row.reconciliationStatus}</span></td><td>{row.settlementDate || "-"}</td><td>{fmtMoney(row.settledRevenue, displayCurrency, 2)}</td><td>{fmtMoney(row.fees, displayCurrency, 2)}</td><td>{fmtMoney(row.refundAmount, displayCurrency, 2)}</td><td>{fmtMoney(row.netPayout, displayCurrency, 2)}</td><td>{fmtMoney(row.delta, displayCurrency, 2)}</td><td>{row.crossMonth ? <span className="recon-cross-badge">Settled in {reconMonthLabel(reconMonthOf(row.settlementDate))}</span> : "-"}</td></tr>)}</tbody></table></div>
            {!reconciliationPageRows.length && <div className="empty-note">No orders match these filters.</div>}
            <div className="recon-pagination"><button disabled={reconciliationPage === 1} onClick={() => setReconciliationPage((page) => Math.max(1, page - 1))}>Prev</button>{reconciliationPages.map((page, index) => <React.Fragment key={page}>{index > 0 && page - reconciliationPages[index - 1] > 1 && <span>...</span>}<button className={page === reconciliationPage ? "active" : ""} onClick={() => setReconciliationPage(page)}>{page}</button></React.Fragment>)}<button disabled={reconciliationPage === reconciliationPageCount} onClick={() => setReconciliationPage((page) => Math.min(reconciliationPageCount, page + 1))}>Next</button></div>
          </div>

          <div className="footer-note">Data powered by DataDoe. Settlement dates are when Amazon posted a financial event, while order dates are purchase dates. A cross-month settlement, a pending recent order, a cancelled order, an MCF order, or a B2B deferral can all create an expected difference; this report makes that timing inspectable instead of hiding it.</div>
        </>}
      </div>
      )}

      {view === "fbaplan" && (
      <div className="container plan-page op-report">
        <div className="controls-bar">
          <div>
            <div className="page-title">FBA Shipment Plan</div>
            <div className="page-sub">Per-ASIN restock recommendation for {refreshScopeAccount?.name || "the selected account"}{selectedBrand === "ALL" ? "" : ` · ${selectedBrand}`} from sales velocity and live FBA{planData?.isUS ? " + AWD" : ""} inventory</div>
          </div>
        </div>

        <PlanningSettingsBar settings={planAccountSettings} onSave={savePlanSettings} busy={planConfigBusy} />

        <div className="plan-controls">
          <label className="plan-field plan-search">
            <span className="plan-field-label">Search</span>
            <span className="plan-search-wrap">
              <Search size={14} />
              <input type="text" placeholder="ASIN, SKU, product, or brand" value={planSearch} onChange={(e) => setPlanSearch(e.target.value)} />
            </span>
          </label>
          <button className="plan-tool-btn" type="button" disabled={!selectedAccountId} onClick={() => setWarehouseImportOpen(true)} title="Bulk-import your seller warehouse units (CSV / XLSX)">
            <Upload size={15} /> Import warehouse
          </button>
          <div className="plan-cols-wrap">
            <button className="plan-tool-btn" type="button" disabled={!planData} onClick={() => setPlanColsOpen((v) => !v)} aria-expanded={planColsOpen} title="Show or hide columns">
              <SlidersHorizontal size={15} /> Columns{planHiddenCols.size > 0 ? ` (${planHiddenCols.size} hidden)` : ""}
            </button>
            {planColsOpen && planData && (
              <PlanColumnChooser
                groups={planColumnGroups} hidden={planHiddenCols} isUS={planData.isUS === true} busy={planColsBusy}
                onToggle={(id) => { const next = new Set(planHiddenCols); if (next.has(id)) next.delete(id); else next.add(id); savePlanColumns(next); }}
                onSelectAll={() => savePlanColumns(new Set())}
                onReset={() => savePlanColumns(new Set(PLAN_DEFAULT_HIDDEN_COLS))}
                onClose={() => setPlanColsOpen(false)}
              />
            )}
          </div>
          <button
            className="plan-export-btn"
            type="button"
            disabled={!planData || planRows.length === 0}
            onClick={() => downloadPlanSpreadsheet(planVisibleColumns, planRows, planData)}
          >
            <Download size={15} />
            Download Excel
          </button>
        </div>

        {planData && planError && <DataQualityAlert tone="error" title="The last refresh failed" detail={planError} />}

        {planData && (
          <>
            <div className="plan-freshness">
              <span className="live-dot" style={{ position: "relative", top: 1 }} />
              <span>Sales through <strong>{planData.salesLatestDate ? fmtDateHuman(planData.salesLatestDate) : "—"}</strong></span>
              <span className="plan-fresh-sep">·</span>
              <span>FBA inventory snapshot <strong>{planData.inventoryDate ? fmtDateHuman(planData.inventoryDate) : "unavailable"}</strong></span>
              {planData.isUS && <><span className="plan-fresh-sep">·</span><span>AWD {planData.awdAvailable ? "included" : "no live units"}</span></>}
              <span className="plan-fresh-sep">·</span>
              <span>{planCachedAt ? `cached ${planCachedAt.toLocaleString()}` : ""}</span>
            </div>

            {!planData.inventoryAvailable && (
              <div className="alert warning">
                <AlertTriangle size={15} /> Live FBA inventory is unavailable for this account right now, so coverage and recommendations show “—”. Sales velocity is still shown.
              </div>
            )}

            <div className="plan-stat-row">
              <div className="plan-stat"><div className="plan-stat-label">ASINs</div><div className="plan-stat-value mono">{planRows.length.toLocaleString("en-US")}</div></div>
              <div className="plan-stat"><div className="plan-stat-label">Needs Restock</div><div className="plan-stat-value mono">{planTotals.restockCount.toLocaleString("en-US")}</div></div>
              <div className="plan-stat"><div className="plan-stat-label">Recommended Units</div><div className="plan-stat-value mono">{planTotals.anyInv ? nInt(planTotals.recommended) : "—"}</div></div>
              <div className="plan-stat"><div className="plan-stat-label">FBA Available</div><div className="plan-stat-value mono">{planTotals.anyInv ? nInt(planTotals.fbaAvailable) : "—"}</div></div>
              <div className="plan-stat"><div className="plan-stat-label">Total FBA Inv.</div><div className="plan-stat-value mono">{planTotals.anyInv ? nInt(planTotals.totalFbaInv) : "—"}</div></div>
            </div>
          </>
        )}

        {planData && planRows.length > 0 ? (
          <div className="panel" style={{ marginTop: 14, padding: 0, overflow: "hidden" }}>
            <div className="plan-scroll">
              <table className="plan-table">
                <thead>
                  {/* Presentation-only group band: Identity / Sales / Forecast / Inventory / ... */}
                  <tr className="plan-group-row" aria-hidden="true">
                    {planGroupSpans.map((g, i) => (
                      <th key={g.group + i} colSpan={g.span}
                        className={"plan-group-th plan-group-" + g.group.toLowerCase().replace(/[^a-z]+/g, "-") + (i === 0 ? " plan-group-id" : "")}>
                        {g.group === "Identity" ? "" : g.group}
                      </th>
                    ))}
                  </tr>
                  <tr>
                    {planVisibleColumns.map((c) => (
                      c.sortKey
                        ? <PlanTh key={c.id} className={c.id === "asin" ? "pt-id" : ""} label={c.label} col={c.sortKey} sort={planSort} onSort={setPlanSortKey} align={c.align || "right"} title={c.thTitle} />
                        : <th key={c.id} title={c.thTitle || undefined} style={c.align === "left" ? { textAlign: "left" } : undefined}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {planRows.map((r) => (
                    <tr key={r.rowKey || r.asin} className={(r.remark === "Restock" ? "plan-restock" : "") + (r.warehouseOnly ? " plan-wh-only" : "")}>
                      {planVisibleColumns.map((c) => c.cell(r))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="plan-totals-row">
                    {planVisibleColumns.map((c) => c.foot(planTotals, planRows))}
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        ) : planData && planRows.length === 0 ? (
          <div className="panel" style={{ marginTop: 14 }}>
            <div className="empty-note">{planSearch ? "No ASINs match your search." : selectedBrand === "ALL" ? "No ASINs found for this account in the reporting window." : "No ASINs match the selected brand."}</div>
          </div>
        ) : (
          <SnapshotGate
            icon={<Boxes size={19} aria-hidden="true" />}
            label="FBA Shipment Plan"
            error={planError}
            loading={planLoading}
            notice={snapshotNotice}
            onRefresh={loadCachedPlan}
            busy={planLoading}
          />
        )}

        <div className="footer-note">
          Unit sales come from DataDoe <code>Sales &amp; Traffic by ASIN &amp; Date</code> (total_units), summed per ASIN for the 3 completed months and the current month to date. A genuinely missing month shows an em dash — never a fabricated 0 — so the 3-month average is only shown when all three completed months have proven data.
          One canonical, non-overlapping inventory model drives every number here (table, totals, export and planning agree). From <code>FBA Inventory Health</code>, each unit is in exactly one bucket: <strong>FBA Available</strong> = <code>available</code> (sellable now); <strong>Reserved (FC)</strong> = <code>reserved_fc_transfer</code> + <code>reserved_fc_processing</code> shown RAW (no subtraction — the reserved FC states and the inbound states are distinct buckets, proven by the source metadata); <strong>Inbound Pipeline</strong> = <code>inbound_working</code> + <code>inbound_shipped</code> + <code>inbound_received</code>. <strong>Cust. Reserved</strong> = <code>reserved_customer_order</code> is already-sold stock, shown for reference and never counted as usable supply.
          {planData?.isUS ? <> <strong>AWD Available</strong> = <code>awd_available_distributable_quantity</code> is distributable and counts as usable supply; <strong>AWD Inbound</strong> = <code>awd_total_inbound_quantity</code> is inbound to the AWD warehouse, not yet distributable, so it is display-only (US only).</> : <> AWD does not apply to non-US accounts and its columns are hidden (never shown as 0).</>}
          {" "}<strong>Total FBA Inv.</strong> = FBA Available + Reserved (FC) + Inbound Pipeline (FBA network only — no AWD, no seller warehouse). <strong>Amazon Network Pos.</strong> = Total FBA Inv.{planData?.isUS ? " + AWD Available" : ""} and is the planning supply. <strong>Seller WH</strong> holds your OWN uncommitted warehouse units (edit inline or bulk-import); never Amazon inventory and never units already in inbound working. Target Units = the corrected daily run rate × the entered coverage days; Recommend = ceil(Target Units − Amazon Network Pos.), floored at 0. FBA Days (MTD DRR) = FBA Available ÷ MTD daily run rate (excludes reserved, inbound and AWD). Planning columns (Pipeline, Horizon Demand, Safety, Target Inv, Ship WH, Produce, Est. Stockout, Priority) come from the per-account/per-SKU planning settings. Live inventory freshness is independent of sales-report freshness; both dates are shown above. Settings, warehouse edits, the column chooser, filters, sorting, and the target-days input recompute locally without new DataDoe requests.
        </div>
        {skuHorizonEdit && (
          <SkuHorizonEditor target={skuHorizonEdit} accountDefault={planAccountSettings.horizon} busy={planConfigBusy}
            onSave={saveSkuHorizon} onClose={() => setSkuHorizonEdit(null)} />
        )}
        {warehouseImportOpen && (
          <WarehouseImportModal
            defaultMarketplace={planData?.marketCountry || ""}
            directory={planSkuDirectory}
            catalogAsins={planCatalogAsins}
            hasDirectory={Array.isArray(planData?.accountSkuDirectory)}
            knownSkus={planKnownSkus}
            skuAsinMap={planSkuAsinMap}
            onApply={bulkImportWarehouse}
            onClose={() => setWarehouseImportOpen(false)}
          />
        )}
      </div>
      )}

      {view === "skupl" && (
      <div className="container skupl-page">
        <div className="controls-bar">
          <div>
            <div className="page-title">SKU P&amp;L Analyzer</div>
            <div className="page-sub">Net profit by SKU for {refreshScopeAccount?.name || "the selected account"}{selectedBrand === "ALL" ? "" : ` · ${selectedBrand}`} · {skuPlMonthLabel}{effectiveSkuCurrency ? ` · ${effectiveSkuCurrency}` : ""}</div>
          </div>
          {skuPlData && (
            <div className="recon-month-picker">
              <label htmlFor="skupl-month">Report month</label>
              <select id="skupl-month" value={skuPlMonth || "ALL"} onChange={(e) => setSkuPlMonth(e.target.value)}>
                <option value="ALL">All 6 Months</option>
                {(skuPlData.months || []).map((month) => <option key={month} value={month}>{reconMonthLabel(month)}</option>)}
              </select>
              {skuPlCurrencies.length > 1 && (
                <>
                  <label htmlFor="skupl-currency">Currency</label>
                  <select id="skupl-currency" value={effectiveSkuCurrency} onChange={(e) => setSkuPlCurrency(e.target.value)}>
                    {skuPlCurrencies.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </>
              )}
            </div>
          )}
        </div>

        {skuPlData && skuPlError && <DataQualityAlert tone="error" title="The last refresh failed" detail={skuPlError} />}

        {!skuPlData && (
          <SnapshotGate
            icon={<Wallet size={19} aria-hidden="true" />}
            label="SKU P&L report"
            error={skuPlError}
            loading={skuPlLoading}
            notice={snapshotNotice}
            onRefresh={loadCachedSkuPl}
            busy={skuPlLoading}
          />
        )}

        {skuPlData && <>
          <div className="recon-freshness">
            <span className="live-dot" style={{ position: "relative", top: 1 }} />
            <span>Profit by SKU &amp; Date from <strong>{fmtDateHuman(skuPlData.from)}</strong> to <strong>{fmtDateHuman(skuPlData.to)}</strong></span>
            <span className="plan-fresh-sep">·</span>
            <span>cached {skuPlCachedAt?.toLocaleString()}</span>
            {skuPlCurrencies.length > 1 && <><span className="plan-fresh-sep">·</span><span>{skuPlCurrencies.length} currencies — showing {effectiveSkuCurrency}</span></>}
          </div>

          {skuPlComputed.length === 0 ? (
            <div className="panel"><div className="empty-note">{selectedBrand === "ALL" ? "No SKU profit rows for this account in the selected month and currency." : "No SKUs match the selected brand in this month and currency."}</div></div>
          ) : <>
            <div className="skupl-kpis">
              <SkuKpi label="Total Sales" value={fmtMoney(skuPlKpis.sales, effectiveSkuCurrency)} />
              <SkuKpi label="Net Profit" value={fmtMoney(skuPlKpis.profit, effectiveSkuCurrency)} tone={skuPlKpis.profit < 0 ? "bad" : "good"} />
              <SkuKpi label="Blended Margin" value={skuPlKpis.margin === null ? "—" : `${skuPlKpis.margin.toFixed(1)}%`} />
              <SkuKpi label="Units" value={nInt(skuPlKpis.units)} />
              <SkuKpi label="Total Cost" value={fmtMoney(skuPlKpis.cost, effectiveSkuCurrency)} />
              <SkuKpi label="Ad Spend" value={fmtMoney(skuPlKpis.adSpend, effectiveSkuCurrency)} />
              <SkuKpi label="Amazon Fees" value={fmtMoney(skuPlKpis.fees, effectiveSkuCurrency)} />
            </div>

            <div className="skupl-insights">
              <div className="panel">
                <div className="panel-head"><div><div className="panel-title">Top Profit SKUs</div><div className="page-sub">Ranked by net profit, not sales</div></div></div>
                <div className="skupl-rank">
                  {skuPlTopProfit.map((r, i) => (
                    <div className="skupl-rank-row" key={(r.sku || r.asin || "") + i}>
                      <span className="skupl-rank-num">{i + 1}</span>
                      <span className="skupl-rank-name" title={r.productName || r.sku}>
                        {r.productName || r.sku || r.asin}
                        <span className="skupl-rank-sub mono">{r.sku || r.asin}</span>
                      </span>
                      <span className="skupl-rank-val mono">
                        {fmtMoney(r.profit, effectiveSkuCurrency)}
                        <span className="skupl-rank-margin">{r.margin === null ? "" : `${r.margin.toFixed(0)}%`}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="panel">
                <div className="panel-head"><div><div className="panel-title">Profit Leaks</div><div className="page-sub">Fix first · {skuPlStatusCounts.loss + skuPlStatusCounts.cogs + skuPlStatusCounts.ad + skuPlStatusCounts.thin} flagged</div></div></div>
                <div className="skupl-leaks">
                  {skuPlLeaks.length === 0 ? <div className="empty-note">No profit leaks flagged in this scope.</div> :
                    skuPlLeaks.map((r, i) => (
                      <div className="skupl-leak-row" key={(r.sku || r.asin || "") + i}>
                        <div className="skupl-leak-head">
                          <span className={"pt-badge sku-badge-" + r.status.tone}>{r.status.label}</span>
                          <span className="skupl-leak-name" title={r.productName || r.sku}>{r.productName || r.sku || r.asin}</span>
                          <span className={"mono skupl-leak-profit" + (r.profit < 0 ? " sku-neg" : "")}>{fmtMoney(r.profit, effectiveSkuCurrency)}</span>
                        </div>
                        <div className="skupl-leak-action">{r.status.action}</div>
                      </div>
                    ))}
                </div>
              </div>
            </div>

            <div className="panel skupl-table-panel" style={{ padding: 0, overflow: "hidden" }}>
              <div className="skupl-toolbar">
                <label className="plan-field skupl-search">
                  <span className="plan-field-label">Search</span>
                  <span className="plan-search-wrap"><Search size={14} /><input value={skuPlSearch} onChange={(e) => setSkuPlSearch(e.target.value)} placeholder="SKU, ASIN, product, or brand" /></span>
                </label>
                <label className="plan-field">
                  <span className="plan-field-label">Status</span>
                  <select value={skuPlStatusFilter} onChange={(e) => setSkuPlStatusFilter(e.target.value)}>
                    {["ALL", "loss", "cogs", "ad", "thin", "ok"].map((k) => <option key={k} value={k}>{skuPlStatusOptionLabel(k)}{k !== "ALL" ? ` (${skuPlStatusCounts[k] || 0})` : ""}</option>)}
                  </select>
                </label>
                <div className="skupl-toolbar-spacer" />
                <button className="plan-export-btn" onClick={() => downloadSkuPlCsv(skuPlSorted, effectiveSkuCurrency, skuPlMonthLabel, refreshScopeAccount?.name)} disabled={!skuPlSorted.length}><Download size={15} />Download CSV</button>
              </div>
              <div className="plan-scroll">
                <table className="plan-table skupl-table">
                  <thead>
                    <tr>
                      <PlanTh className="pt-id" label="Product / SKU" col="productName" sort={skuPlSort} onSort={setSkuPlSortKey} align="left" />
                      <PlanTh label="Sales" col="sales" sort={skuPlSort} onSort={setSkuPlSortKey} />
                      <PlanTh label="Profit" col="profit" sort={skuPlSort} onSort={setSkuPlSortKey} />
                      <PlanTh label="Margin %" col="margin" sort={skuPlSort} onSort={setSkuPlSortKey} />
                      <PlanTh label="Units" col="units" sort={skuPlSort} onSort={setSkuPlSortKey} />
                      <PlanTh label="Total Cost" col="cost" sort={skuPlSort} onSort={setSkuPlSortKey} />
                      <PlanTh label="Amazon Fees" col="fees" sort={skuPlSort} onSort={setSkuPlSortKey} />
                      <PlanTh label="Ad Spend" col="adSpend" sort={skuPlSort} onSort={setSkuPlSortKey} />
                      <PlanTh label="COGS" col="cogs" sort={skuPlSort} onSort={setSkuPlSortKey} />
                      <PlanTh label="Ad/Sales %" col="adSalesRatio" sort={skuPlSort} onSort={setSkuPlSortKey} />
                      <PlanTh label="Status" col="status" sort={skuPlSort} onSort={setSkuPlSortKey} align="left" />
                    </tr>
                  </thead>
                  <tbody>
                    {skuPlPageRows.map((r, i) => (
                      <tr key={(r.sku || r.asin || "") + i} className={r.status.key === "loss" ? "skupl-row-loss" : ""}>
                        <td className="pt-id">
                          <div className="pt-name" title={r.productName || r.sku}>{r.productName || "(no product name)"}</div>
                          <div className="pt-meta mono">{r.sku || "—"}{r.asin ? ` · ${r.asin}` : ""}</div>
                          {r.brand && <div className="pt-brand">{r.brand}</div>}
                        </td>
                        <td className="mono">{fmtMoney(r.sales, effectiveSkuCurrency)}</td>
                        <td className={"mono pt-strong" + (r.profit < 0 ? " sku-neg" : "")}>{fmtMoney(r.profit, effectiveSkuCurrency)}</td>
                        <td className="mono">{r.margin === null ? "—" : `${r.margin.toFixed(1)}%`}</td>
                        <td className="mono">{nInt(r.units)}</td>
                        <td className="mono">{fmtMoney(r.cost, effectiveSkuCurrency)}</td>
                        <td className="mono">{fmtMoney(r.fees, effectiveSkuCurrency)}</td>
                        <td className="mono">{fmtMoney(r.adSpend, effectiveSkuCurrency)}</td>
                        <td className={"mono skupl-cogs-cell" + (r.cogsMissing ? " sku-warn" : "")}>
                          <span>{r.cogsMissing ? "missing" : fmtMoney(r.cogs, effectiveSkuCurrency)}</span>
                          <button className="icon-action" type="button" onClick={() => openCogsEditor(r)} title="Update COGS per unit" aria-label={`Update COGS for ${r.sku || r.asin || "SKU"}`}><Pencil size={13} /></button>
                        </td>
                        <td className="mono">{r.adSalesRatio === null ? "—" : `${r.adSalesRatio.toFixed(1)}%`}</td>
                        <td><span className={"pt-badge sku-badge-" + r.status.tone} title={r.status.action || ""}>{r.status.label}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!skuPlPageRows.length && <div className="empty-note" style={{ padding: "14px 16px" }}>No SKUs match these filters.</div>}
              <div className="recon-pagination">
                <button disabled={skuPlSafePage === 1} onClick={() => setSkuPlPage((page) => Math.max(1, page - 1))}>Prev</button>
                {skuPlPages.map((page, index) => <React.Fragment key={page}>{index > 0 && page - skuPlPages[index - 1] > 1 && <span>…</span>}<button className={page === skuPlSafePage ? "active" : ""} onClick={() => setSkuPlPage(page)}>{page}</button></React.Fragment>)}
                <button disabled={skuPlSafePage === skuPlPageCount} onClick={() => setSkuPlPage((page) => Math.min(skuPlPageCount, page + 1))}>Next</button>
              </div>
            </div>
          </>}

          <div className="footer-note">
            Profit comes straight from DataDoe <code>Profit by SKU &amp; Date</code> (the <code>profit</code> column), which already blends settlements, COGS, and ad spend — it is not rebuilt from raw orders. Sales, Profit, Total Cost, Ad Spend, Amazon Fees, COGS, and Units are summed per SKU; every ratio (Margin %, Ad/Sales %, Blended Margin) is recomputed from those sums, never averaged. <strong>Ad/Sales %</strong> = ad spend ÷ total sales (this report does not aggregate ad sales, so it is not classic ACoS). Currencies are never combined; when an account reports more than one, use the currency selector. This report always uses six <strong>full</strong> calendar months because Amazon fees settle in batches by settlement date, so a partial month can badly misstate profit. A “Check COGS” flag means COGS is zero/missing, so that SKU’s margin is overstated — verify COGS before trusting it. A per-unit COGS override adjusts COGS, total cost, profit, and margins for that account/SKU locally; it is included in the CSV. Month, currency, brand, search, sort, filter, and CSV export all run locally; only Refresh calls DataDoe.
          </div>
        </>}
      </div>
      )}

      {view === "keywordrank" && (
      <div className="container skupl-page keyword-rank-page">
        <div className="controls-bar">
          <div>
            <div className="page-title">Keyword Rank &amp; Share</div>
            <div className="page-sub">Money keywords for {refreshScopeAccount?.name || "the selected account"}{selectedBrand === "ALL" ? "" : ` / ${selectedBrand}`} · organic rank supports the share-of-query signal</div>
          </div>
        </div>

        {keywordRankData && keywordRankError && <DataQualityAlert tone="error" title="The last refresh failed" detail={keywordRankError} />}

        {!keywordRankData && (
          <SnapshotGate
            icon={<TrendingUp size={19} aria-hidden="true" />}
            label="Keyword Rank report"
            error={keywordRankError}
            loading={keywordRankLoading}
            notice={snapshotNotice}
            onRefresh={loadCachedKeywordRank}
            busy={keywordRankLoading}
          />
        )}

        {keywordRankData && <>
          <div className="recon-freshness">
            <span className="live-dot" style={{ position: "relative", top: 1 }} />
            <span>{keywordRankData.cadence === "weekly" ? "Weekly" : keywordRankData.cadence === "monthly" ? "Monthly fallback" : "Baseline"} SQP through <strong>{keywordRankData.periods?.length ? fmtDateHuman(keywordRankData.periods[keywordRankData.periods.length - 1]) : "unavailable"}</strong></span>
            <span className="plan-fresh-sep">·</span>
            <span>cached {keywordRankCachedAt?.toLocaleString()}</span>
            <span className="plan-fresh-sep">·</span>
            <span>{keywordRankData.periods?.length || 0} comparable period{keywordRankData.periods?.length === 1 ? "" : "s"}</span>
          </div>

          {keywordRankData.cadence === "baseline" && (
            <div className="alert warning">
              <AlertTriangle size={15} /> Not enough SQP history for a trend yet ({keywordRankData.periods?.length || 0} period{keywordRankData.periods?.length === 1 ? "" : "s"}; weekly trend needs 4). Current share and rank are shown as a baseline. Refresh again as SQP history builds.
            </div>
          )}

          <div className="plan-stat-row">
            <div className="plan-stat"><div className="plan-stat-label">Money Keywords</div><div className="plan-stat-value mono">{keywordRankStats.moneyKeywords.toLocaleString("en-US")}</div></div>
            <div className="plan-stat"><div className="plan-stat-label">At Risk</div><div className="plan-stat-value mono">{keywordRankStats.atRisk.toLocaleString("en-US")}</div></div>
            <div className="plan-stat"><div className="plan-stat-label">Emerging</div><div className="plan-stat-value mono">{keywordRankStats.emerging.toLocaleString("en-US")}</div></div>
            <div className="plan-stat"><div className="plan-stat-label">Holding / Rising</div><div className="plan-stat-value mono">{keywordRankStats.stable.toLocaleString("en-US")}</div></div>
          </div>

          <div className="panel skupl-table-panel" style={{ marginTop: 14, padding: 0, overflow: "hidden" }}>
            <div className="skupl-toolbar keyword-rank-toolbar">
              <label className="plan-field skupl-search">
                <span className="plan-field-label">Search</span>
                <span className="plan-search-wrap"><Search size={14} /><input value={keywordRankSearch} onChange={(event) => setKeywordRankSearch(event.target.value)} placeholder="Keyword, ASIN, product, or brand" /></span>
              </label>
              <label className="plan-field">
                <span className="plan-field-label">ASIN</span>
                <select value={keywordRankAsin} onChange={(event) => setKeywordRankAsin(event.target.value)}>
                  <option value="ALL">All ASINs</option>
                  {keywordRankAsins.map((item) => <option key={item.asin} value={item.asin}>{item.name ? `${item.name} · ${item.asin}` : item.asin}</option>)}
                </select>
              </label>
              <label className="plan-field">
                <span className="plan-field-label">Signal</span>
                <select value={keywordRankStatus} onChange={(event) => setKeywordRankStatus(event.target.value)}>
                  <option value="ALL">All signals</option>
                  {["lost", "slipping", "rising", "emerging", "stable", "baseline"].map((status) => <option key={status} value={status}>{sqpStatusMeta(status).label} ({keywordRankStatusCounts[status] || 0})</option>)}
                </select>
              </label>
            </div>
            <div className="plan-scroll">
              <table className="plan-table keyword-rank-table">
                <thead>
                  <tr>
                    <PlanTh className="pt-id" label="Product / ASIN" col="productName" sort={keywordRankSort} onSort={setKeywordRankSortKey} align="left" />
                    <PlanTh label="Keyword" col="query" sort={keywordRankSort} onSort={setKeywordRankSortKey} align="left" />
                    <PlanTh label="Query Vol." col="volume" sort={keywordRankSort} onSort={setKeywordRankSortKey} />
                    <PlanTh label="Impr. Share" col="impressionShare" sort={keywordRankSort} onSort={setKeywordRankSortKey} />
                    <PlanTh label="Share Trend" col="shareDelta" sort={keywordRankSort} onSort={setKeywordRankSortKey} />
                    <PlanTh label="Organic Rank" col="rank" sort={keywordRankSort} onSort={setKeywordRankSortKey} />
                    <PlanTh label="Rank Trend" col="rankDelta" sort={keywordRankSort} onSort={setKeywordRankSortKey} />
                    <PlanTh label="Your CVR" col="conversion" sort={keywordRankSort} onSort={setKeywordRankSortKey} />
                    <PlanTh label="Signal" col="status" sort={keywordRankSort} onSort={setKeywordRankSortKey} align="left" />
                    <PlanTh label="Suggested Action" col="priority" sort={keywordRankSort} onSort={setKeywordRankSortKey} align="left" />
                  </tr>
                </thead>
                <tbody>
                  {keywordRankSorted.map((row) => (
                    <tr key={`${row.asin}|${row.query}`} className={row.status === "lost" || row.status === "slipping" ? "plan-restock" : ""}>
                      <td className="pt-id">
                        <div className="pt-name" title={row.productName || row.asin}>{row.productName || "(no product name)"}</div>
                        <div className="pt-meta mono">{row.asin}</div>
                        {row.brand && <div className="pt-brand">{row.brand}</div>}
                      </td>
                      <td className="keyword-query" title={row.query}>{row.query}</td>
                      <td className="mono">{nInt(row.latest.volume)}</td>
                      <td className="mono">{sqpPercent(row.latest.impressionShare)}</td>
                      <td className={"mono " + (row.impressionShareDelta < 0 ? "keyword-bad" : row.impressionShareDelta > 0 ? "keyword-good" : "")}>{row.status === "baseline" ? "—" : sqpSignedPoints(row.impressionShareDelta)}</td>
                      <td className="mono">{row.latest.rank === null ? "—" : Math.round(row.latest.rank)}</td>
                      <td className={"mono " + (row.rankDelta > 0 ? "keyword-bad" : row.rankDelta < 0 ? "keyword-good" : "")}>{row.status === "baseline" || !row.rankDelta ? "—" : `${row.rankDelta > 0 ? "+" : ""}${row.rankDelta.toFixed(1)}`}</td>
                      <td className="mono">{sqpPercent(row.conversionRate)}</td>
                      <td><span className={"pt-badge sku-badge-" + row.statusMeta.tone}>{row.statusMeta.label}</span></td>
                      <td className="keyword-lever">{row.statusMeta.lever}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!keywordRankSorted.length && <div className="empty-note" style={{ padding: "14px 16px" }}>{keywordRankRows.length ? "No money keywords match these filters." : "No converting SQP keywords were found for this account and brand in the available history."}</div>}
          </div>

          <div className="footer-note">
            Search Query Performance comes from DataDoe <code>Search Query Performance (SQP) by ASIN</code>. A money keyword is a query where the selected ASIN actually generated purchases; alerts are ranked by query volume and purchase share. Impression Share = child-ASIN impressions ÷ all-ASIN query impressions. Organic rank is supporting context only: query share is the primary visibility signal. Weekly mode compares the latest 2–3 periods with the prior 2–3 periods; when fewer than four weekly periods exist, the report uses monthly SQP if available, otherwise shows an honest baseline. Lost/Slipping: check listing term coverage, stock, Buy Box, suppression, and ad support. Rising: protect and scale. Emerging: test indexing and ads. All filters and sorting are local; only Refresh calls DataDoe.
          </div>
        </>}
      </div>
      )}

      {cogsEditRow && (
        <div className="cogs-modal-backdrop" role="presentation" onMouseDown={closeCogsEditor}>
          <section className="cogs-modal" role="dialog" aria-modal="true" aria-labelledby="cogs-modal-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="cogs-modal-head">
              <div>
                <div id="cogs-modal-title" className="panel-title">Update COGS</div>
                <div className="page-sub">{cogsEditRow.productName || cogsEditRow.sku || cogsEditRow.asin}</div>
              </div>
              <button className="icon-action" type="button" onClick={closeCogsEditor} title="Close" aria-label="Close COGS editor"><X size={16} /></button>
            </div>
            <div className="cogs-modal-meta mono">{cogsEditRow.sku || "—"}{cogsEditRow.asin ? ` · ${cogsEditRow.asin}` : ""}</div>
            <label className="plan-field cogs-modal-input">
              <span className="plan-field-label">COGS per unit ({cogsEditRow.currency || effectiveSkuCurrency})</span>
              <input type="number" min="0" step="0.01" inputMode="decimal" autoFocus value={cogsEditValue} onChange={(event) => { setCogsEditValue(event.target.value); setCogsEditError(""); }} onKeyDown={(event) => { if (event.key === "Enter") saveCogsOverride(); }} />
            </label>
            {cogsEditError && <div className="cogs-modal-error">{cogsEditError}</div>}
            <div className="cogs-modal-actions">
              {cogsEditRow.hasCogsOverride && <button className="secondary-action" type="button" onClick={resetCogsOverride}><RotateCcw size={14} />Use DataDoe COGS</button>}
              <button className="plan-export-btn" type="button" onClick={saveCogsOverride}>Save COGS</button>
            </div>
          </section>
        </div>
      )}

      {view === "contentchanges" && (
      <div className="container content-changes-page">
        <div className="controls-bar">
          <div>
            <div className="page-title">Content Change Alerts</div>
            <div className="page-sub">Amazon A+ and branded-item content changes for {refreshScopeAccount?.name || "the selected account"}{selectedBrand === "ALL" ? "" : ` / ${selectedBrand}`}</div>
          </div>
          {contentChangesData && <button className="plan-export-btn" onClick={() => downloadContentChangesCsv(contentChangeEvents, refreshScopeAccount?.name)} disabled={!contentChangeEvents.length}><Download size={15} />Download CSV</button>}
        </div>

        {contentChangesData && contentChangesError && <DataQualityAlert tone="error" title="The last refresh failed" detail={contentChangesError} />}

        {!contentChangesData && (
          <SnapshotGate
            icon={<BellRing size={19} aria-hidden="true" />}
            label="content alert feed"
            error={contentChangesError}
            loading={contentChangesLoading}
            notice={snapshotNotice}
            onRefresh={loadCachedContentChanges}
            busy={contentChangesLoading}
          />
        )}

        {contentChangesData && <>
          <div className="recon-freshness">
            <span className="live-dot" style={{ position: "relative", top: 1 }} />
            <span>Latest events delivered by DataDoe</span>
            <span className="plan-fresh-sep">/</span>
            <span>cached {contentChangesCachedAt?.toLocaleString()}</span>
            <span className="plan-fresh-sep">/</span>
            <span>Amazon may publish these notifications within about 2 hours of the content change</span>
          </div>

          <div className="recon-kpis">
            <ReconKpi label="Events" value={contentChangeStats.total.toLocaleString("en-US")} note="Cached account total" />
            <ReconKpi label="ASIN-linked" value={contentChangeStats.asinLinked.toLocaleString("en-US")} note="ASIN extracted from payload" />
            <ReconKpi label="Brand-attributed" value={contentChangeStats.brandLinked.toLocaleString("en-US")} note="Matched to product catalog" />
            <ReconKpi label="Latest event" value={contentChangeStats.latest ? new Date(contentChangeStats.latest).toLocaleDateString() : "-"} note={contentChangeStats.latest ? new Date(contentChangeStats.latest).toLocaleTimeString() : "No events returned"} />
          </div>

          {selectedBrand !== "ALL" && contentChangesData.unassignedEvents > 0 && (
            <div className="recon-notice"><Info size={15} /> Events without an ASIN-to-brand catalog match are excluded while a specific brand is selected. Select All Brands to review those unassigned events.</div>
          )}

          <div className="panel content-alerts-panel">
            <div className="panel-head"><div><div className="panel-title">Notification Feed</div><div className="page-sub">{contentChangeEvents.length.toLocaleString("en-US")} matching events. Search and filters work locally.</div></div></div>
            <div className="recon-filters">
              <label className="plan-field recon-search"><span className="plan-field-label">Search</span><span className="plan-search-wrap"><Search size={14} /><input value={contentChangesSearch} onChange={(e) => setContentChangesSearch(e.target.value)} placeholder="ASIN, brand, notification ID, or payload..." /></span></label>
              <label className="plan-field recon-select"><span className="plan-field-label">Event type</span><select value={contentChangesType} onChange={(e) => setContentChangesType(e.target.value)}><option value="ALL">All types</option>{contentChangeTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
            </div>
            <div className="recon-table-scroll"><table className="recon-table content-alerts-table"><thead><tr><th>Event time</th><th>Type</th><th>ASINs</th><th>Brands</th><th>Notification ID</th><th>Details</th></tr></thead><tbody>{contentChangeEvents.map((event, index) => <tr key={event.notificationId || `${event.eventTime}-${index}`}><td>{event.eventTime ? new Date(event.eventTime).toLocaleString(selectedMarketplace.locale, { timeZone: selectedMarketplace.timeZone }) : "-"}</td><td>{event.notificationType || "-"}</td><td className="mono">{event.asins?.length ? event.asins.join(", ") : "-"}</td><td>{event.brands?.length ? event.brands.join(", ") : "Unassigned"}</td><td className="mono">{event.notificationId || "-"}</td><td><span className="content-preview" title={event.payloadPreview || event.metadataPreview || ""}>{event.metadataPreview || event.payloadPreview || "-"}</span></td></tr>)}</tbody></table></div>
            {!contentChangeEvents.length && <div className="empty-note">{selectedBrand === "ALL" ? "No content change events were returned for this account." : "No content change events match the selected brand."}</div>}
          </div>

          <div className="footer-note">Data powered by DataDoe <code>Branded Item Content Change Notifications</code>. This is a monitoring feed for Amazon A+ / branded-item content changes, not a sales or catalog history report. Amazon's payload schema can vary; the dashboard extracts ASINs from the payload and joins them to the Product Catalog before applying the shared brand filter. Events without an identifiable or catalog-mapped ASIN remain visible only under Select All Brands. Opening this report reads the browser cache; only Refresh calls DataDoe.</div>
        </>}
      </div>
      )}

      {view === "salesmovers" && (
        <SalesMovers
          data={salesMovers.data}
          loading={salesMovers.loading}
          error={salesMovers.error}
          accountName={refreshScopeAccount?.name}
          selectedBrand={selectedBrand}
          currency={displayCurrency}
        />
      )}

      {view === "skumovement" && (
        <SkuMovement
          data={skuMovement.data}
          loading={skuMovement.loading}
          updating={skuMovement.updating || skuIdentBusy}
          error={skuMovement.error}
          accountName={refreshScopeAccount?.name}
          selectedBrand={selectedBrand}
          onReload={skuMovement.reload}
          cachedAt={skuMovement.cachedAt}
          recentDays={skuRecentDays}
          onRecentDaysChange={onSkuRecentDaysChange}
          hiddenColumns={skuHiddenCols}
          onColumnsChange={onSkuColumnsChange}
          onSaveIdentifier={onSaveIdentifier}
          onBulkIdentifiers={onBulkIdentifiers}
          canEdit={!!session?.access_token && !!selectedAccountId}
        />
      )}

      {view === "campaign-ads" && CAMPAIGN_ADS_TAB && (
        <CampaignAds
          accountId={selectedAccountId}
          accountName={refreshScopeAccount?.name}
          selectedBrand={selectedBrand}
          accessToken={session?.access_token}
          isAdmin={isAdmin}
        />
      )}

      {view === "listinghealth" && (
        <ListingHealth
          data={listingHealth.data}
          loading={listingHealth.loading}
          error={listingHealth.error}
          accountName={refreshScopeAccount?.name}
          selectedBrand={selectedBrand}
          currency={displayCurrency}
        />
      )}

      {view === "buybox" && (
        <BuyBoxLoss
          data={buyBox.data}
          loading={buyBox.loading}
          error={buyBox.error}
          accountName={refreshScopeAccount?.name}
          selectedBrand={selectedBrand}
          currency={displayCurrency}
        />
      )}

      {view === "returns" && (
        <ReturnsLeakage
          data={returns.data}
          loading={returns.loading}
          error={returns.error}
          accountName={refreshScopeAccount?.name}
          selectedBrand={selectedBrand}
          currency={displayCurrency}
          user={session?.user || null}
        />
      )}

      {view === "ppc" && (
        <PpcPerformance
          data={ppc.data}
          loading={ppc.loading}
          error={ppc.error}
          accountName={refreshScopeAccount?.name}
          selectedBrand={selectedBrand}
          currency={displayCurrency}
        />
      )}

      {view === "optimizer" && (
        <ListingOptimizer
          data={optimizer.data}
          loading={optimizer.loading}
          error={optimizer.error}
          accountName={refreshScopeAccount?.name}
          selectedBrand={selectedBrand}
        />
      )}

      {view === "priority" && (
        <PriorityFeed
          reports={{ salesMovers, listingHealth, buyBox, returns, ppc, optimizer }}
          accountName={refreshScopeAccount?.name}
          selectedBrand={selectedBrand}
          currency={displayCurrency}
        />
      )}
        </div>
      </div>
    </div>
  );
}

// KPI card for the SKU P&L Analyzer.
function SkuKpi({ label, value, tone }) {
  return <div className="skupl-kpi"><div className="skupl-kpi-label">{label}</div><div className={"skupl-kpi-value mono" + (tone === "bad" ? " sku-neg" : tone === "good" ? " sku-pos" : "")}>{value}</div></div>;
}

// Sortable header cell for the plan table.
function PlanTh({ label, col, sort, onSort, align = "right", className = "", title = "" }) {
  const active = sort.key === col;
  return (
    <th
      className={`${className} ${align === "left" ? "pt-left" : ""} pt-sortable ${active ? "pt-sorted" : ""}`}
      onClick={() => onSort(col)}
      title={title ? `${title}\n(Click to sort)` : "Click to sort"}
    >
      <span className="pt-th-inner">
        {label}
        {active ? (sort.dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="pt-th-idle" />}
      </span>
    </th>
  );
}

function ReconKpi({ label, value, note }) {
  return <div className="recon-kpi"><div className="recon-kpi-label">{label}</div><div className="recon-kpi-value mono">{value}</div><div className="recon-kpi-note">{note}</div></div>;
}

function ReconSelect({ label, value, onChange, options }) {
  return <label className="plan-field recon-select"><span className="plan-field-label">{label}</span><select value={value} onChange={(e) => onChange(e.target.value)}>{options.map((option) => <option key={option} value={option}>{option === "ALL" ? "All" : option === "YES" ? "Yes" : option === "NO" ? "No" : option === "SAME" ? "Same month" : option === "CROSS" ? "Cross-month only" : option}</option>)}</select></label>;
}

function ReconTh({ label, col, sort, setSort, align = "right" }) {
  const active = sort.key === col;
  return <th className={align === "left" ? "recon-left" : ""} onClick={() => setSort((previous) => ({ key: col, dir: previous.key === col && previous.dir === "asc" ? "desc" : "asc" }))} title="Click to sort"><span>{label}{active ? (sort.dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} />}</span></th>;
}

// Rows of the Daily Reporting table, in display order. Ad-derived rows fall
// back to "—" until advertising data is present on the fetched rows.
const DAILY_METRICS = [
  { key: "sales", label: "Total Sales", fmt: (c, cur) => fmtMoney(c.sales, cur) },
  { key: "adSales", label: "Ad Sales", fmt: (c, cur) => (c.hasAd ? fmtMoney(c.adSales, cur) : "—") },
  { key: "adSpend", label: "Ad Spends", fmt: (c, cur) => (c.hasAd ? fmtMoney(c.adSpend, cur) : "—") },
  { key: "clicks", label: "Clicks", fmt: (c) => (c.hasAd ? c.clicks.toLocaleString("en-US") : "—") },
  { key: "units", label: "Units", fmt: (c) => c.units.toLocaleString("en-US") },
  // ROI is the BUSINESS return on ad spend: Total Sales / Ad Spend (NOT Ad Sales / Ad Spend). The cell already
  // carries the column-SUMMED sales + adSpend (see dailyReport cells), so formatDailyRoi computes SUM(Total
  // Sales) / SUM(Ad Spend) for the period -- never an average of row-level ratios. Zero/missing/unavailable Ad
  // Spend -> em dash. Two decimals. ACoS/TACoS keep their existing business meaning (extracted unchanged).
  { key: "roi", label: "ROI", highlight: true, fmt: (c) => formatDailyRoi(c.sales, c.adSpend, c.hasAd) },
  { key: "acos", label: "ACoS %", fmt: (c) => formatDailyAcos(c.adSpend, c.adSales, c.hasAd) },
  { key: "tacos", label: "TACoS %", fmt: (c) => formatDailyTacos(c.adSpend, c.sales, c.hasAd) },
];


export default function App() {
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [passwordSetup, setPasswordSetup] = useState(false);
  const [access, setAccess] = useState(null);
  const [accessError, setAccessError] = useState("");

  useEffect(() => {
    if (!supabase) { setAuthReady(true); return undefined; }
    let active = true;
    const restoreSession = async () => {
      const { data, error } = await supabase.auth.getSession();
      if (!active) return;
      // A saved refresh token can recover an expired access token. Do not
      // discard that session merely because the initial read hit an error.
      const restored = error ? await supabase.auth.refreshSession() : { data };
      if (!active) return;
      const nextSession = restored.data?.session || null;
      setSession(nextSession);
      configureApiSession(nextSession);
      if (window.location.hash.includes("type=invite") || window.location.search.includes("type=invite")) setPasswordSetup(true);
      setAuthReady(true);
    };
    restoreSession().catch(() => {
      if (!active) return;
      setSession(null);
      configureApiSession(null);
      setAuthReady(true);
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return;
      setSession(nextSession || null);
      configureApiSession(nextSession || null);
      if (event === "PASSWORD_RECOVERY") setPasswordSetup(true);
      if (event === "USER_UPDATED") setPasswordSetup(false);
      if (event === "SIGNED_OUT") { setAccess(null); setAccessError(""); setPasswordSetup(false); }
    });
    return () => { active = false; subscription.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!session?.access_token) { setAccess(null); return; }
    let active = true;
    setAccess(null); setAccessError("");
    const loadAccess = (initial) => authFetch("/api/access?action=me", session.access_token)
      .then((body) => { if (active) setAccess(body.access); })
      .catch((error) => { if (active && initial) setAccessError(error.message || "Unable to load dashboard access."); });
    loadAccess(true);
    // BRAND-SCOPE cache-invalidation: an admin can narrow a user's account/brand grants while that user's tab stays
    // open. Re-fetch the authoritative access on focus / tab-visible so a mid-session grant change is picked up
    // WITHOUT a manual reload: setAccess with the new grants changes the access fingerprint, which fires the
    // DashboardApp purge effect (clears localStorage + IndexedDB report caches) and re-resolves every brand selector
    // from the newly authorized grants. Server requests are always projected regardless; this closes the display
    // window where an already-open session could still show removed brand names. A refetch failure keeps the current
    // access (never blanks a working session on a transient network blip).
    const revalidate = () => { if (active && (typeof document === "undefined" || document.visibilityState === "visible")) loadAccess(false); };
    window.addEventListener("focus", revalidate);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", revalidate);
    return () => {
      active = false;
      window.removeEventListener("focus", revalidate);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", revalidate);
    };
  }, [session?.access_token]);

  const signOut = useCallback(async () => {
    if (supabase) await supabase.auth.signOut();
    setSession(null); setAccess(null); configureApiSession(null);
  }, []);

  if (!supabase) return <div className="auth-root"><style>{STYLE}</style><div className="auth-panel"><div className="auth-logo">UR</div><div className="auth-title">Login setup incomplete</div><div className="auth-sub">The public Supabase browser configuration is missing from Vercel.</div></div></div>;
  if (!authReady) return <div className="auth-root"><style>{STYLE}</style><div className="loading-screen">Loading secure session…</div></div>;
  if (!session) return <LoginScreen passwordSetup={passwordSetup} />;
  if (passwordSetup) return <LoginScreen passwordSetup />;
  if (accessError) return <div className="auth-root"><style>{STYLE}</style><div className="auth-panel"><div className="auth-logo">UR</div><div className="auth-title">Access unavailable</div><div className="auth-error"><AlertTriangle size={15} />{accessError}</div><button className="auth-submit" onClick={signOut}>Sign out</button></div></div>;
  if (!access) return <div className="auth-root"><style>{STYLE}</style><div className="loading-screen">Loading your dashboard access…</div></div>;
  return <DashboardApp session={session} access={access} onSignOut={signOut} />;
}

async function removeUnauthorizedLargeCachedData(allowedAccountIds, isAdmin) {
  if (isAdmin) return;
  const allowed = new Set(allowedAccountIds);
  const ownerPrefix = API_CACHE_PREFIX + encodeURIComponent(apiCacheOwner) + ":";
  try {
    const db = await openLargeCache();
    await new Promise((resolve, reject) => {
      const store = db.transaction(LARGE_CACHE_STORE, "readwrite").objectStore(LARGE_CACHE_STORE);
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) { resolve(); return; }
        const key = String(current.key || "");
        if (key.startsWith(ownerPrefix)) {
          const accountId = new URLSearchParams(key.slice(ownerPrefix.length)).get("ids");
          if (accountId && !allowed.has(accountId)) current.delete();
        }
        current.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    });
    db.close();
  } catch (e) {
    // Server authorization remains the final protection if IndexedDB is unavailable.
  }
}

// Phase 11: clear EVERY large cached report entry for the current owner (a full purge on an access-fingerprint change).
async function clearAllOwnerLargeCache() {
  const ownerPrefix = API_CACHE_PREFIX + encodeURIComponent(apiCacheOwner) + ":";
  try {
    const db = await openLargeCache();
    await new Promise((resolve, reject) => {
      const store = db.transaction(LARGE_CACHE_STORE, "readwrite").objectStore(LARGE_CACHE_STORE);
      const cursor = store.openCursor();
      cursor.onsuccess = () => { const cur = cursor.result; if (!cur) { resolve(); return; } if (String(cur.key || "").startsWith(ownerPrefix)) cur.delete(); cur.continue(); };
      cursor.onerror = () => reject(cursor.error);
    });
    db.close();
  } catch (e) { /* IndexedDB may be unavailable; server authorization is final */ }
}
