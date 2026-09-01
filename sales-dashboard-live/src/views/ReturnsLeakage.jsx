// Returns & Refund Leakage (returns-leakage-v3) -- an advanced, zero-export report rendered ENTIRELY from the durable
// v3 snapshot: an account's per-ASIN return + settlement history (row.daily[]) plus an index-aligned account series.
// A user-chosen window (7/14/30/60) and its prior-period comparison are recomputed CLIENT-side from the saved daily
// history with the SAME arithmetic the server used -- never a refetch, never DataDoe. Every filter/sort/search/page/
// export/column choice/window choice is LOCAL. Money never crosses currencies; a rate is recomputed from summed
// numerators/denominators and withheld when unsafe; return fees are clamped ONCE per window; COGS is shown but never
// counted as leakage; a null stays an em dash, never a fabricated 0. Falls back gracefully to a full-window view when
// an older snapshot without the trend surface is served.

import React, { useMemo, useState, useEffect, useRef } from "react";
import {
  Undo2, ChevronRight, ChevronDown, SlidersHorizontal, FileSpreadsheet,
} from "lucide-react";
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";

import {
  RETURN_BUCKET_META,
  buildReturnsInsights,
  buildReturnsRows,
  insightExportRows,
  returnsPortfolioRate,
} from "../lib/insights.js";
import {
  DEFAULT_RETURNS_WINDOW, clampReturnsWindow, availableWindowOptions,
  windowSlices, applyRowWindow, aggregateReturns, kpiDelta, buildReturnsTrend, sumSeriesGroup,
  pickPrimaryCurrency, hasReturnsSeries,
} from "../lib/returns-window.js";
import { downloadCsv, reportFilename } from "../lib/csv.js";
import { buildXlsx } from "../lib/xlsx.js";
import { fmtDateHuman, fmtMoney, fmtRate, nInt, compactNumber } from "../lib/format.js";
import { CHART } from "../styles/theme.js";
import { GradientKpi, ChartCard, ChartTooltip, SegmentedControl } from "../components/ui.jsx";
import {
  ExportButton, FreshnessBar, Notice, Pagination, PriorityActions, ReportHeader, SearchField,
  SelectField, SnapshotState, SortTh, StaleScopeNotice, moneyScope, snapshotFreshnessLabel,
  totalMoney, sortRows, useSortState,
} from "./shared.jsx";

const PAGE_SIZE = 50;
const num = (v) => (Number(v) || 0);

/* ------------------------------------------------------------------ columns */
// The optional (hideable) columns. Product/ASIN identity is NEVER hideable. Order here is the render order.
const COLUMNS = [
  { key: "brand", label: "Brand", group: "Identity", align: "left", sortKey: "brand" },
  { key: "leakage", label: "Total Leakage", group: "Money", sortKey: "totalLeakage", hint: "Customer refunds + seller-borne return fees. COGS excluded." },
  { key: "net", label: "Net Impact", group: "Money", sortKey: "netImpact", hint: "Total leakage minus the referral fee Amazon credits back on refunds." },
  { key: "refunds", label: "Refunds", group: "Money", sortKey: "refundedAmount", hint: "Settled customer refunds in the window." },
  { key: "fees", label: "Return Fees", group: "Money", sortKey: "returnFees", hint: "Return commission + FBA per-unit return fee − restocking recovered (clamped once over the window)." },
  { key: "referral", label: "Referral Credit", group: "Money", sortKey: "refundedReferralFeeCredit", hint: "Referral fee credited back to the seller on refunds." },
  { key: "cogs", label: "COGS Refunded", group: "Money", sortKey: "cogsOnRefundedUnits", hint: "Goods value on refunded units. Shown, never counted as leakage." },
  { key: "returned", label: "Returned", group: "Returns", sortKey: "returnCount", hint: "Return records in the selected window." },
  { key: "provisional", label: "Provisional", group: "Returns", sortKey: "provisionalReturnCount", hint: "Returns in the grace period, awaiting settlement — not leakage yet." },
  { key: "refundedUnits", label: "Refunded Units", group: "Returns", sortKey: "refundedUnitsSettled", hint: "Units on settled refund events." },
  { key: "fbafbm", label: "FBA / FBM", group: "Returns", sortKey: null, hint: "Returns split by fulfilment channel." },
  { key: "pending", label: "Pending", group: "Returns", sortKey: "pendingReturnRequests", hint: "Return requests still awaiting approval." },
  { key: "ordered", label: "Ordered Units", group: "Rate", sortKey: "orderedUnits", hint: "Units ordered in the window — the rate denominator." },
  { key: "rate", label: "Return Rate", group: "Rate", sortKey: "returnRate", hint: "Returns ÷ ordered units, recomputed from summed counts and withheld when the denominator is unsafe." },
  { key: "fixable", label: "Fixable %", group: "Rate", sortKey: "actionableShare", hint: "Product / listing / sizing reasons as a share of returns (full history)." },
  { key: "reason", label: "Dominant Reason", group: "Reason", align: "left", sortKey: "dominantBucket", hint: "Named only when one reason bucket is ≥ half a product's returns (full history)." },
];
const COLUMN_GROUPS = ["Identity", "Money", "Returns", "Rate", "Reason"];
const DEFAULT_HIDDEN = ["referral", "cogs", "provisional", "pending", "ordered", "fixable"];

const ACCESSORS = {
  productName: (r) => String(r.productName || r.asin || "").toLowerCase(),
  brand: (r) => String(r.brand || "").toLowerCase(),
  totalLeakage: (r) => num(r.totalLeakage),
  netImpact: (r) => num(r.netImpact),
  refundedAmount: (r) => num(r.refundedAmount),
  returnFees: (r) => num(r.returnFees),
  refundedReferralFeeCredit: (r) => num(r.refundedReferralFeeCredit),
  cogsOnRefundedUnits: (r) => num(r.cogsOnRefundedUnits),
  returnCount: (r) => num(r.returnCount),
  provisionalReturnCount: (r) => num(r.provisionalReturnCount),
  refundedUnitsSettled: (r) => num(r.refundedUnitsSettled),
  pendingReturnRequests: (r) => num(r.pendingReturnRequests),
  orderedUnits: (r) => (r.orderedUnits == null ? null : num(r.orderedUnits)),
  returnRate: (r) => (r.returnRate == null ? null : num(r.returnRate)),
  actionableShare: (r) => (r.actionableShare == null ? null : num(r.actionableShare)),
  dominantBucket: (r) => String(r.dominantBucket || "zzz"),
};

// Reason-bucket colours (deterministic), reused by the breakdown and the reason column badge tone mapping.
const REASON_COLORS = {
  product_quality: CHART.red, listing_accuracy: CHART.gold, sizing: CHART.violet,
  delivery: CHART.teal, low_actionability: "#8E87AA", other: CHART.neutral,
};

/* ------------------------------------------------------------- cell factory */
// One function drives BOTH the on-screen cell and the export cell, so the two can never drift.
function cellFor(key, r, cur) {
  const money = (v) => fmtMoney(v, cur);
  switch (key) {
    case "brand":
      return { display: r.brand || "—", text: r.brand || "", num: null };
    case "leakage":
      return { display: <span className="mono pt-strong sku-neg">{money(r.totalLeakage)}</span>, text: num(r.totalLeakage).toFixed(2), num: num(r.totalLeakage) };
    case "net":
      return { display: <span className="mono">{money(r.netImpact)}</span>, text: num(r.netImpact).toFixed(2), num: num(r.netImpact) };
    case "refunds":
      return { display: <span className="mono">{money(r.refundedAmount)}</span>, text: num(r.refundedAmount).toFixed(2), num: num(r.refundedAmount) };
    case "fees":
      return { display: <span className="mono">{money(r.returnFees)}</span>, text: num(r.returnFees).toFixed(2), num: num(r.returnFees) };
    case "referral":
      return { display: <span className="mono">{r.refundedReferralFeeCredit ? money(r.refundedReferralFeeCredit) : "—"}</span>, text: num(r.refundedReferralFeeCredit).toFixed(2), num: num(r.refundedReferralFeeCredit) };
    case "cogs":
      return { display: <span className="mono">{r.cogsOnRefundedUnits ? money(r.cogsOnRefundedUnits) : "—"}</span>, text: num(r.cogsOnRefundedUnits).toFixed(2), num: num(r.cogsOnRefundedUnits) };
    case "returned":
      return { display: <span className="mono">{nInt(r.returnCount)}</span>, text: String(Math.round(num(r.returnCount))), num: Math.round(num(r.returnCount)) };
    case "provisional":
      return { display: <span className="mono">{r.provisionalReturnCount ? nInt(r.provisionalReturnCount) : "—"}</span>, text: String(Math.round(num(r.provisionalReturnCount))), num: Math.round(num(r.provisionalReturnCount)) };
    case "refundedUnits":
      return { display: <span className="mono">{nInt(r.refundedUnitsSettled)}</span>, text: String(Math.round(num(r.refundedUnitsSettled))), num: Math.round(num(r.refundedUnitsSettled)) };
    case "fbafbm":
      return { display: <span className="mono">{nInt(r.fbaReturns)} / {nInt(r.fbmReturns)}</span>, text: `${Math.round(num(r.fbaReturns))} / ${Math.round(num(r.fbmReturns))}`, num: null };
    case "pending":
      return { display: <span className="mono">{r.pendingReturnRequests ? nInt(r.pendingReturnRequests) : "—"}</span>, text: String(Math.round(num(r.pendingReturnRequests))), num: Math.round(num(r.pendingReturnRequests)) };
    case "ordered":
      return { display: <span className="mono">{r.orderedUnits == null ? "—" : nInt(r.orderedUnits)}</span>, text: r.orderedUnits == null ? "" : String(Math.round(r.orderedUnits)), num: r.orderedUnits == null ? null : Math.round(r.orderedUnits) };
    case "rate":
      return {
        display: r.returnRate == null
          ? <span className="movers-unattributed" title={r.lagInflated ? "More units were returned than ordered inside this window, so these returns belong to earlier orders. A percentage would be meaningless, so it is withheld and the row is ranked by money." : r.rateWithheld ? "The ordered/settlement evidence spans more than one currency, so the returns count cannot be divided by a single-currency denominator." : "No ordered units in the window to divide by."}>{r.lagInflated ? "lag" : "—"}</span>
          : <span className="mono">{fmtRate(r.returnRate)}</span>,
        text: r.returnRate == null ? (r.lagInflated ? "withheld - lag artefact" : r.rateWithheld ? "withheld - mixed currency" : "") : r.returnRate.toFixed(1),
        num: r.returnRate == null ? null : Number(r.returnRate.toFixed(1)),
      };
    case "fixable":
      return { display: <span className="mono">{r.actionableShare == null ? "—" : fmtRate(r.actionableShare, 0)}</span>, text: r.actionableShare == null ? "" : r.actionableShare.toFixed(0), num: r.actionableShare == null ? null : Math.round(r.actionableShare) };
    case "reason":
      return {
        display: r.dominantBucketMeta
          ? <>
            <span className={"pt-badge sku-badge-" + (r.dominantBucketMeta.actionable ? "warn" : "ok")} title={r.dominantBucketMeta.action}>{r.dominantBucketMeta.label}</span>
            <div className="buybox-cause-detail">
              {r.dominantShare == null ? "" : `${r.dominantShare.toFixed(0)}% of returns · `}
              {(r.topReasons || []).slice(0, 2).map((e) => `${e.reason} (${e.count})`).join(", ")}
            </div>
          </>
          : <span className="movers-unattributed">no return records in window</span>,
        text: r.dominantBucketMeta ? `${r.dominantBucketMeta.label}${r.dominantShare == null ? "" : ` ${r.dominantShare.toFixed(0)}%`}` : "",
        num: null,
      };
    default:
      return { display: null, text: "", num: null };
  }
}

/* ------------------------------------------------------------- ColumnChooser */
function ColumnChooser({ hidden, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const hiddenSet = new Set(hidden);
  const toggle = (key) => { const s = new Set(hiddenSet); if (s.has(key)) s.delete(key); else s.add(key); onChange([...s]); };
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" className="cache-refresh-btn" onClick={() => setOpen((o) => !o)} title="Choose visible columns"><SlidersHorizontal size={14} />Columns</button>
      {open && (
        <div className="panel" style={{ position: "absolute", right: 0, top: "110%", zIndex: 30, width: 250, padding: 12, maxHeight: "70vh", overflowY: "auto", boxShadow: "0 8px 30px rgba(0,0,0,0.25)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <button type="button" className="link-btn" onClick={() => onChange([])}>Select all</button>
            <button type="button" className="link-btn" onClick={() => onChange(DEFAULT_HIDDEN.slice())}>Reset default</button>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 6 }}>Product / ASIN is always shown.</div>
          {COLUMN_GROUPS.map((g) => {
            const cols = COLUMNS.filter((c) => c.group === g);
            if (!cols.length) return null;
            return (
              <div key={g} style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text-secondary)", marginBottom: 3 }}>{g}</div>
                {cols.map((c) => (
                  <label key={c.key} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, padding: "2px 0", cursor: "pointer" }}>
                    <input type="checkbox" checked={!hiddenSet.has(c.key)} onChange={() => toggle(c.key)} />
                    {c.label}
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- SegmentBar */
// A compact stacked-count breakdown: a single horizontal bar plus a legend with counts and shares. Counts only, so it
// is currency-agnostic and safe to sum across currencies.
function SegmentBar({ title, subtitle, segments }) {
  const items = (segments || []).filter((s) => num(s.value) > 0);
  const total = items.reduce((t, s) => t + num(s.value), 0);
  return (
    <section className="panel">
      <div className="rl-seg-title">{title}</div>
      {subtitle && <div className="rl-seg-sub">{subtitle}</div>}
      {total <= 0 ? (
        <div className="empty-note">No returns of this kind in the selected window.</div>
      ) : (
        <>
          <div className="rl-seg-bar" role="img" aria-label={`${title} breakdown`}>
            {items.map((s) => <i key={s.key} style={{ width: `${(num(s.value) / total) * 100}%`, background: s.color }} title={`${s.label}: ${nInt(s.value)}`} />)}
          </div>
          <div className="rl-seg-legend">
            {items.map((s) => (
              <div className="rl-seg-row" key={s.key}>
                <span className="rl-seg-key"><span className="rl-seg-dot" style={{ background: s.color }} />{s.label}</span>
                <span><b className="rl-seg-val">{nInt(s.value)}</b><span className="rl-seg-share">{((num(s.value) / total) * 100).toFixed(0)}%</span></span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/* -------------------------------------------------------------- KPI helpers */
function deltaSub(cmp, { pp = false, hasComparison } = {}) {
  if (!hasComparison) return { text: "no prior period", tone: undefined };
  if (pp) {
    if (cmp == null) return { text: "vs prior · —", tone: undefined };
    const arrow = cmp > 0.05 ? "▲" : cmp < -0.05 ? "▼" : "▬";
    return { text: `${arrow} ${Math.abs(cmp).toFixed(1)}pp vs prior`, tone: cmp > 0.05 ? "bad" : cmp < -0.05 ? "good" : undefined };
  }
  const { delta, pct } = cmp;
  if (pct == null) return { text: delta > 0 ? "▲ new vs prior" : "vs prior · —", tone: delta > 0 ? "bad" : undefined };
  const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "▬";
  return { text: `${arrow} ${Math.abs(pct).toFixed(0)}% vs prior`, tone: delta > 0 ? "bad" : delta < 0 ? "good" : undefined };
}

/* -------------------------------------------------------------- Drill panel */
function DrillDetail({ r, cur }) {
  const money = (v) => fmtMoney(v, cur);
  const Row = ({ label, value }) => <div className="rl-dl-row"><span>{label}</span><b>{value}</b></div>;
  return (
    <div className="rl-drill">
      <div>
        <h4>Return evidence</h4>
        <div className="rl-dl">
          <Row label="Returned items (window)" value={nInt(r.returnCount)} />
          <Row label="Confirmed / provisional" value={`${nInt(r.confirmedReturnCount ?? r.returnCount)} / ${nInt(r.provisionalReturnCount ?? 0)}`} />
          <Row label="FBA / FBM" value={`${nInt(r.fbaReturns)} / ${nInt(r.fbmReturns)}`} />
          <Row label="Pending requests" value={nInt(r.pendingReturnRequests)} />
          <Row label="Reason mix" value={(r.topReasons || []).length ? (r.topReasons || []).slice(0, 4).map((e) => `${e.reason} (${e.count})`).join(", ") : "—"} />
          <Row label="Dominant cause" value={r.dominantBucketMeta ? `${r.dominantBucketMeta.label}${r.dominantShare == null ? "" : ` · ${r.dominantShare.toFixed(0)}%`}` : "not attributed"} />
        </div>
      </div>
      <div>
        <h4>Settlement evidence</h4>
        <div className="rl-dl">
          <Row label="Customer refunds" value={money(r.refundedAmount)} />
          <Row label="Refund tax" value={r.refundTax ? money(r.refundTax) : "—"} />
          <Row label="Return commission" value={r.commissionAbs != null ? money(r.commissionAbs) : "—"} />
          <Row label="FBA per-unit return fee" value={r.fbaUnitFeeAbs != null ? money(r.fbaUnitFeeAbs) : "—"} />
          <Row label="Restocking recovered" value={r.restockAbs ? money(r.restockAbs) : "—"} />
          <Row label="Referral fee credit" value={r.refundedReferralFeeCredit ? money(r.refundedReferralFeeCredit) : "—"} />
          <Row label="COGS on refunded units" value={r.cogsOnRefundedUnits ? money(r.cogsOnRefundedUnits) : "—"} />
          <Row label="Refund events / units" value={`${nInt(r.refundEvents)} / ${nInt(r.refundedUnitsSettled)}`} />
        </div>
      </div>
      <div>
        <h4>Calculation</h4>
        <div className="rl-dl">
          <Row label="Refunds + return fees" value={`${money(r.refundedAmount)} + ${money(r.returnFees)}`} />
          <Row label="= Total leakage" value={money(r.totalLeakage)} />
          <Row label="− Referral credit" value={r.refundedReferralFeeCredit ? money(r.refundedReferralFeeCredit) : money(0)} />
          <Row label="= Net impact" value={money(r.netImpact)} />
          <Row label="Return rate" value={r.returnRate == null ? (r.lagInflated ? "withheld (lag artefact)" : r.rateWithheld ? "withheld (mixed currency)" : "—") : `${nInt(r.returnCount)} ÷ ${nInt(r.orderedUnits)} = ${fmtRate(r.returnRate)}`} />
          <Row label="COGS in leakage?" value="No — shown separately" />
        </div>
      </div>
    </div>
  );
}

/* =========================================================================== */
export default function ReturnsLeakage({ data, loading, error, accountName, selectedBrand, currency, user }) {
  const [search, setSearch] = useState("");
  const [bucketFilter, setBucketFilter] = useState("ALL");
  const [viewFilter, setViewFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState(null);
  const [sort, onSort] = useSortState("totalLeakage", ["productName", "brand", "dominantBucket"]);
  const [chartCurrencyOverride, setChartCurrencyOverride] = useState(null);

  // Per-user prefs (window N + hidden columns) live ONLY in localStorage -- no server call. First paint reads them.
  const prefsKey = user?.id ? `returns.cols.prefs.${user.id}` : "returns.cols.prefs";
  const [windowDays, setWindowDays] = useState(DEFAULT_RETURNS_WINDOW);
  const [hiddenColumns, setHiddenColumns] = useState(DEFAULT_HIDDEN);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(prefsKey);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && typeof p === "object") {
          if (p.windowDays != null) setWindowDays(Number(p.windowDays) || DEFAULT_RETURNS_WINDOW);
          if (Array.isArray(p.hiddenColumns)) setHiddenColumns(p.hiddenColumns.map(String));
        }
      }
    } catch { /* ignore -- render the defaults */ }
  }, [prefsKey]);
  const persist = (patch) => {
    const next = {
      windowDays: patch.windowDays != null ? patch.windowDays : windowDays,
      hiddenColumns: patch.hiddenColumns != null ? patch.hiddenColumns : hiddenColumns,
    };
    if (patch.windowDays != null) setWindowDays(next.windowDays);
    if (patch.hiddenColumns != null) setHiddenColumns(next.hiddenColumns);
    try { localStorage.setItem(prefsKey, JSON.stringify(next)); } catch { /* ignore */ }
  };

  const hasSeries = hasReturnsSeries(data);
  const dayAxis = hasSeries ? data.dayAxis : [];
  const axisLen = dayAxis.length;
  const cutoff = (data && (data.provisional?.cutoff || data.freshness?.provisionalFrom)) || null;
  const graceDays = (data && (data.provisional?.graceDays ?? data.graceDays ?? data.freshness?.graceDays)) ?? null;

  // The effective window: the saved choice clamped to what the proven axis can serve. Without the trend surface the
  // window is simply the whole snapshot window and the selector is hidden.
  const N = hasSeries ? clampReturnsWindow(windowDays, axisLen) : (data?.window?.days || axisLen);
  const slices = useMemo(() => (hasSeries ? windowSlices(dayAxis, N) : { windowDates: [], prevDates: [], windowSet: new Set(), prevSet: new Set(), windowIdx: [], prevIdx: [] }), [hasSeries, dayAxis, N]);

  // Scope rows (server already brand-projected; the client selectedBrand narrows within the authorized set), then the
  // window recompute overlays the selected window's figures while PRESERVING the full-history reason mix.
  const scopeRows = useMemo(() => buildReturnsRows(data, selectedBrand), [data, selectedBrand]);
  const rows = useMemo(() => (hasSeries ? scopeRows.map((r) => applyRowWindow(r, slices.windowSet, cutoff)) : scopeRows), [hasSeries, scopeRows, slices.windowSet, cutoff]);
  const prevRows = useMemo(() => (hasSeries ? scopeRows.map((r) => applyRowWindow(r, slices.prevSet, cutoff)) : []), [hasSeries, scopeRows, slices.prevSet, cutoff]);
  const hasComparison = hasSeries && slices.prevDates.length > 0;

  // KPIs + portfolio rate over the FULL scope (not the search/table filters), matching the other reports.
  const recentAgg = useMemo(() => aggregateReturns(rows), [rows]);
  const prevAgg = useMemo(() => aggregateReturns(prevRows), [prevRows]);
  const portfolio = useMemo(() => returnsPortfolioRate(rows), [rows]);
  const prevPortfolio = useMemo(() => returnsPortfolioRate(prevRows), [prevRows]);
  const rateDeltaPP = portfolio.rate != null && prevPortfolio.rate != null ? portfolio.rate - prevPortfolio.rate : null;

  // Insights re-derive from the windowed rows; the window's day count feeds the money-basis text.
  const insightsData = useMemo(() => ({ ...data, window: { ...(data?.window || {}), days: N } }), [data, N]);
  const insights = useMemo(() => (data ? buildReturnsInsights(insightsData, rows) : []), [data, insightsData, rows]);

  // Chart currency (money charts never cross currencies).
  const primaryCurrency = useMemo(() => pickPrimaryCurrency(data) || currency, [data, currency]);
  const currencies = Array.isArray(data?.currencies) ? data.currencies.filter(Boolean) : [];
  const chartCurrency = chartCurrencyOverride && currencies.includes(chartCurrencyOverride) ? chartCurrencyOverride : primaryCurrency;
  const money = moneyScope(data, currency);

  const trend = useMemo(() => (hasSeries ? buildReturnsTrend(rows, slices.windowDates, chartCurrency, cutoff) : []), [hasSeries, rows, slices.windowDates, chartCurrency, cutoff]);

  // Windowed portfolio breakdowns from the index-aligned account series.
  const series = hasSeries ? data.series : null;
  const reasonSeg = useMemo(() => Object.entries(sumSeriesGroup(series?.reasonBucket, slices.windowIdx))
    .map(([key, value]) => ({ key, value, label: RETURN_BUCKET_META[key]?.label || key, color: REASON_COLORS[key] || CHART.neutral }))
    .sort((a, b) => b.value - a.value), [series, slices.windowIdx]);
  const channelSeg = useMemo(() => {
    const s = sumSeriesGroup(series?.channel, slices.windowIdx);
    return [
      { key: "FBA", value: s.FBA, label: "FBA", color: CHART.primary },
      { key: "FBM", value: s.FBM, label: "FBM", color: CHART.teal },
      { key: "UNKNOWN", value: s.UNKNOWN, label: "Unknown", color: CHART.neutral },
    ];
  }, [series, slices.windowIdx]);
  const statusSeg = useMemo(() => {
    const s = sumSeriesGroup(series?.status, slices.windowIdx);
    return [
      { key: "settled", value: s.settled, label: "Settled", color: CHART.positive },
      { key: "pending", value: s.pending, label: "Pending / provisional", color: CHART.gold },
    ];
  }, [series, slices.windowIdx]);
  const payerSeg = useMemo(() => {
    const s = sumSeriesGroup(series?.labelPayer, slices.windowIdx);
    return [
      { key: "seller", value: s.seller, label: "Seller-paid label", color: CHART.red },
      { key: "amazon", value: s.amazon, label: "Amazon-paid", color: CHART.violet },
      { key: "other", value: s.other, label: "Other / unknown", color: CHART.neutral },
    ];
  }, [series, slices.windowIdx]);

  /* ---------------------------------------------------------------- table */
  const shown = (key) => !new Set(hiddenColumns).has(key);
  const visibleCols = useMemo(() => COLUMNS.filter((c) => shown(c.key)), [hiddenColumns]);

  const bucketCounts = useMemo(() => {
    const counts = {};
    rows.forEach((r) => { if (r.dominantBucket) counts[r.dominantBucket] = (counts[r.dominantBucket] || 0) + 1; });
    return counts;
  }, [rows]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (bucketFilter !== "ALL" && r.dominantBucket !== bucketFilter) return false;
      if (viewFilter === "HIGH_RATE" && !(r.returnRate != null && r.returnRate >= 15)) return false;
      if (viewFilter === "PROVISIONAL" && !(num(r.provisionalReturnCount) > 0)) return false;
      if (viewFilter === "UNMATCHED" && !(num(r.returnCount) > 0 && num(r.refundEvents) === 0 && num(r.refundedAmount) === 0)) return false;
      if (!query) return true;
      const reasons = (r.topReasons || []).map((e) => e.reason).join(" ");
      return `${r.asin || ""} ${r.sku || ""} ${r.productName || ""} ${r.brand || ""} ${reasons}`.toLowerCase().includes(query);
    });
  }, [rows, search, bucketFilter, viewFilter]);
  const sorted = useMemo(() => sortRows(filtered, ACCESSORS, sort, "totalLeakage"), [filtered, sort]);

  useEffect(() => { setPage(1); setExpanded(null); }, [search, bucketFilter, viewFilter, selectedBrand, sort.key, sort.dir, N]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  /* --------------------------------------------------------------- exports */
  // ONE export spec drives both CSV and XLSX so a downloaded file always matches the model. Comprehensive (not tied to
  // column visibility) so nothing measured is lost on download.
  const EXPORT_SPEC = [
    { h: "Product Name", t: (r) => r.productName || "", n: () => null },
    { h: "ASIN", t: (r) => r.asin || "", n: () => null },
    { h: "SKU", t: (r) => r.sku || "", n: () => null },
    { h: "Brand", t: (r) => r.brand || "", n: () => null },
    { h: "Currency", t: (r) => r.currency || "", n: () => null },
    { h: "Window Days", t: () => String(N), n: () => N },
    { h: "Total Leakage", t: (r) => num(r.totalLeakage).toFixed(2), n: (r) => num(r.totalLeakage) },
    { h: "Net Impact", t: (r) => num(r.netImpact).toFixed(2), n: (r) => num(r.netImpact) },
    { h: "Customer Refunds", t: (r) => num(r.refundedAmount).toFixed(2), n: (r) => num(r.refundedAmount) },
    { h: "Refund Tax", t: (r) => num(r.refundTax).toFixed(2), n: (r) => num(r.refundTax) },
    { h: "Return Fees (seller)", t: (r) => num(r.returnFees).toFixed(2), n: (r) => num(r.returnFees) },
    { h: "Referral Fee Credit", t: (r) => num(r.refundedReferralFeeCredit).toFixed(2), n: (r) => num(r.refundedReferralFeeCredit) },
    { h: "COGS on Refunded Units", t: (r) => num(r.cogsOnRefundedUnits).toFixed(2), n: (r) => num(r.cogsOnRefundedUnits) },
    { h: "Returned Items", t: (r) => String(Math.round(num(r.returnCount))), n: (r) => Math.round(num(r.returnCount)) },
    { h: "Confirmed Returns", t: (r) => String(Math.round(num(r.confirmedReturnCount ?? r.returnCount))), n: (r) => Math.round(num(r.confirmedReturnCount ?? r.returnCount)) },
    { h: "Provisional Returns", t: (r) => String(Math.round(num(r.provisionalReturnCount))), n: (r) => Math.round(num(r.provisionalReturnCount)) },
    { h: "Refunded Units (settled)", t: (r) => String(Math.round(num(r.refundedUnitsSettled))), n: (r) => Math.round(num(r.refundedUnitsSettled)) },
    { h: "Refund Events", t: (r) => String(Math.round(num(r.refundEvents))), n: (r) => Math.round(num(r.refundEvents)) },
    { h: "FBA Returns", t: (r) => String(Math.round(num(r.fbaReturns))), n: (r) => Math.round(num(r.fbaReturns)) },
    { h: "FBM Returns", t: (r) => String(Math.round(num(r.fbmReturns))), n: (r) => Math.round(num(r.fbmReturns)) },
    { h: "Pending Requests", t: (r) => String(Math.round(num(r.pendingReturnRequests))), n: (r) => Math.round(num(r.pendingReturnRequests)) },
    { h: "Ordered Units (window)", t: (r) => (r.orderedUnits == null ? "" : String(Math.round(r.orderedUnits))), n: (r) => (r.orderedUnits == null ? null : Math.round(r.orderedUnits)) },
    { h: "Return Rate %", t: (r) => (r.returnRate == null ? (r.lagInflated ? "withheld - lag" : r.rateWithheld ? "withheld - mixed currency" : "") : r.returnRate.toFixed(1)), n: (r) => (r.returnRate == null ? null : Number(r.returnRate.toFixed(1))) },
    { h: "Fixable Share %", t: (r) => (r.actionableShare == null ? "" : r.actionableShare.toFixed(0)), n: (r) => (r.actionableShare == null ? null : Math.round(r.actionableShare)) },
    { h: "Dominant Reason", t: (r) => (r.dominantBucketMeta ? r.dominantBucketMeta.label : ""), n: () => null },
    { h: "Dominant Share %", t: (r) => (r.dominantShare == null ? "" : r.dominantShare.toFixed(0)), n: (r) => (r.dominantShare == null ? null : Math.round(r.dominantShare)) },
    { h: "Top Reasons", t: (r) => (r.topReasons || []).map((e) => `${e.reason} (${e.count})`).join(" | "), n: () => null },
    { h: "Fix Lever", t: (r) => (r.dominantBucketMeta ? r.dominantBucketMeta.lever : ""), n: () => null },
  ];
  const fileBase = reportFilename("returns-leakage", accountName, data?.asOf).replace(/\.csv$/i, "");
  const exportCsv = () => downloadCsv(sorted.map((r) => Object.fromEntries(EXPORT_SPEC.map((c) => [c.h, c.t(r)]))), `${fileBase}.csv`);
  const exportXlsx = () => {
    const header = EXPORT_SPEC.map((c) => c.h);
    const body = sorted.map((r) => EXPORT_SPEC.map((c) => { const v = c.n(r); return v == null ? c.t(r) : v; }));
    const bytes = buildXlsx([{ name: "Returns & Refund Leakage", rows: [header, ...body], freezeHeaderRows: 1 }], { modified: new Date() });
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${fileBase}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const exportInsights = () => downloadCsv(insightExportRows(insights), reportFilename("returns-leakage-insights", accountName, data?.asOf));

  /* ---------------------------------------------------------------- render */
  const state = <SnapshotState data={data} loading={loading} error={error} label="Returns & Refund Leakage report" icon={<Undo2 size={22} />} />;
  const scopeLabel = `${accountName || "the selected account"}${selectedBrand === "ALL" ? "" : ` · ${selectedBrand}`}`;
  const windowOptions = hasSeries ? availableWindowOptions(axisLen) : [];
  const fresh = data?.freshness || null;
  const stamp = (v) => { if (!v) return "—"; const d = new Date(v); return Number.isFinite(d.getTime()) ? d.toLocaleString() : String(v); };

  return (
    <div className="container skupl-page">
      <ReportHeader
        title="Returns &amp; Refund Leakage"
        subtitle={`What returns actually cost ${scopeLabel} — settled leakage, fees and rates over a window you choose, ranked by money not percentage`}
      />

      {state}

      <StaleScopeNotice data={data} />

      {data && !data.snapshotMissing && <>
        <FreshnessBar items={[
          hasSeries
            ? `${N}-day window ${fmtDateHuman(slices.windowDates[0])} – ${fmtDateHuman(slices.windowDates[slices.windowDates.length - 1])}`
            : `${data.window.days}-day window ${fmtDateHuman(data.window.from)} – ${fmtDateHuman(data.window.to)}`,
          `reasons from ${data.returnsSourceLabel} (about ${data.returnHistoryDays} days of history)`,
          `money from ${data.moneySourceLabel} REFUND events`,
          `rates from ${data.rateSourceLabel}, which can lag about ${data.rateSourceLagDays} days`,
          snapshotFreshnessLabel(data),
        ]} />

        <Notice>
          A refund only exists once Amazon posts a <strong>REFUND settlement event</strong>. Cancelled orders never settle and so never appear here, and a return still awaiting approval shows as a pending request rather than as money lost. {data.pendingReturnRequests > 0 ? `${data.pendingReturnRequests} return request${data.pendingReturnRequests === 1 ? " is" : "s are"} pending approval in this window.` : "No return requests are pending approval in this window."}
        </Notice>

        {money.mixed && (
          <Notice>
            This account reports {data.currencies.join(", ")}. Each product keeps its settlement currency and money totals are only meaningful within a single currency, so combined money figures show an em dash and the trend charts are shown for <strong>{chartCurrency}</strong>. Nothing is converted.
          </Notice>
        )}

        {(data.fbmOnly?.sellerBorneLabelCost > 0 || data.fbmOnly?.refundedAmount > 0) && (
          <Notice>
            The Returns source also reports FBM-only figures for this window: {fmtMoney(data.fbmOnly.refundedAmount, chartCurrency)} of refunded amount and {fmtMoney(data.fbmOnly.sellerBorneLabelCost, chartCurrency)} of return labels billed to the seller. These are FBM-only columns and are shown separately — they are not part of the per-product settlement leakage below, which covers both channels.
          </Notice>
        )}

        {!hasSeries && (
          <Notice tone="info">
            This saved snapshot predates the advanced trend surface, so the window selector and trend charts are hidden and the figures below cover the full {data.window.days}-day window. They refresh automatically on the next scheduled data refresh.
          </Notice>
        )}

        {/* Controls: window, chart currency, columns */}
        <div className="rl-controls">
          {hasSeries && windowOptions.length > 1 && (
            <div className="plan-field">
              <span className="plan-field-label">Window</span>
              <SegmentedControl
                ariaLabel="Return window"
                options={windowOptions.map((n) => ({ value: String(n), label: `${n}d` }))}
                value={String(N)}
                onChange={(v) => persist({ windowDays: clampReturnsWindow(v, axisLen) })}
              />
            </div>
          )}
          {currencies.length > 1 && (
            <SelectField label="Chart currency" value={chartCurrency || ""} onChange={setChartCurrencyOverride} options={currencies.map((c) => ({ value: c, label: c }))} />
          )}
          <div className="skupl-toolbar-spacer" />
          <ColumnChooser hidden={hiddenColumns} onChange={(cols) => persist({ hiddenColumns: cols })} />
        </div>

        {/* KPI strip with prior-period comparison */}
        <div className="rvkpi-grid rvkpi-grid-6">
          {(() => {
            const cRet = deltaSub(kpiDelta(recentAgg.returned, prevAgg.returned), { hasComparison });
            const cRefund = deltaSub(kpiDelta(recentAgg.refunds, prevAgg.refunds), { hasComparison });
            const cLeak = deltaSub(kpiDelta(recentAgg.leakage, prevAgg.leakage), { hasComparison });
            const cFees = deltaSub(kpiDelta(recentAgg.fees, prevAgg.fees), { hasComparison });
            const cNet = deltaSub(kpiDelta(recentAgg.netImpact, prevAgg.netImpact), { hasComparison });
            const cRate = deltaSub(rateDeltaPP, { pp: true, hasComparison });
            const rateVal = portfolio.rate != null ? (portfolio.ratePartial ? `${fmtRate(portfolio.rate)} · partial` : fmtRate(portfolio.rate)) : (portfolio.ratePartial ? "— · partial" : "—");
            return <>
              <GradientKpi label="Returned units" value={nInt(recentAgg.returned)} sub={hasSeries ? cRet.text : `${nInt(recentAgg.confirmed)} confirmed`} tone={hasSeries ? cRet.tone : undefined} gradient="linear-gradient(135deg,#A78BFA,#7C3AED)" hint={`${nInt(recentAgg.confirmed)} confirmed · ${nInt(recentAgg.provisional)} provisional${graceDays != null ? ` (grace ${graceDays}d)` : ""}`} />
              <GradientKpi label="Return rate" value={rateVal} sub={hasSeries ? cRate.text : "proven rows only"} tone={hasSeries ? cRate.tone : undefined} hint="Returned units ÷ ordered units, recomputed from summed counts. 'Partial' excludes currency-ambiguous, no-denominator and lag-inflated rows." />
              <GradientKpi label="Settled refunds" value={totalMoney(recentAgg.refunds, money, fmtMoney)} sub={hasSeries && !money.mixed ? cRefund.text : undefined} tone={hasSeries && !money.mixed ? cRefund.tone : undefined} gradient="linear-gradient(135deg,#FF6B6B,#FF8E53)" hint={money.mixed ? "Mixed currencies — a combined total would be meaningless." : "Customer refunds settled in the window."} />
              <GradientKpi label="Recoverable leakage" value={totalMoney(recentAgg.leakage, money, fmtMoney)} sub={hasSeries && !money.mixed ? cLeak.text : undefined} tone={hasSeries && !money.mixed ? cLeak.tone : undefined} hint="Settled refunds + seller-borne return fees. COGS excluded." />
              <GradientKpi label="Return fees" value={totalMoney(recentAgg.fees, money, fmtMoney)} sub={hasSeries && !money.mixed ? cFees.text : undefined} tone={hasSeries && !money.mixed ? cFees.tone : undefined} hint="Return commission + FBA per-unit return fee − restocking recovered, clamped once over the window." />
              <GradientKpi label="Est. net impact" value={totalMoney(recentAgg.netImpact, money, fmtMoney)} sub={hasSeries && !money.mixed ? cNet.text : undefined} tone={hasSeries && !money.mixed ? cNet.tone : undefined} hint="Leakage minus the referral fee Amazon credits back. COGS still excluded." />
            </>;
          })()}
        </div>

        <div className="rl-prov">
          <span className={"pt-badge " + (recentAgg.provisional > 0 ? "sku-badge-warn" : "sku-badge-ok")}>
            {recentAgg.provisional > 0 ? `${nInt(recentAgg.provisional)} provisional return${recentAgg.provisional === 1 ? "" : "s"}` : "No provisional returns"}
          </span>
          <span>
            {graceDays != null ? `Returns in the last ${graceDays} day${graceDays === 1 ? "" : "s"} are awaiting settlement` : "Recent returns awaiting settlement"} and are counted as pending — never as leakage money until a REFUND event posts. Confirmed leakage above excludes them.
          </span>
        </div>

        {/* Trend charts */}
        {hasSeries && trend.length > 0 && (
          <div className="rl-charts">
            <ChartCard title="Returns over time" subtitle={`Return records per day by channel · last ${N} days`}>
              <div className="rl-chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={trend} margin={{ top: 8, right: 12, left: -14, bottom: 0 }}>
                    <CartesianGrid stroke={CHART.grid} vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: CHART.axis }} axisLine={{ stroke: CHART.axisLine }} tickLine={false} minTickGap={16} tickMargin={7} />
                    <YAxis tick={{ fontSize: 10, fill: CHART.axis }} axisLine={false} tickLine={false} width={38} allowDecimals={false} />
                    <Tooltip cursor={{ fill: "rgba(139,92,246,0.06)" }} content={(p) => (
                      <ChartTooltip {...p} rows={(pt) => [
                        { key: "fba", label: "FBA returns", value: nInt(pt.fba), color: CHART.primary },
                        { key: "fbm", label: "FBM returns", value: nInt(pt.fbm), color: CHART.teal },
                        pt.provisional ? { key: "prov", label: "of which provisional", value: nInt(pt.provisional) } : null,
                      ]} />
                    )} />
                    <Bar dataKey="fba" stackId="c" fill={CHART.primary} radius={[0, 0, 0, 0]} />
                    <Bar dataKey="fbm" stackId="c" fill={CHART.teal} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>

            <ChartCard title="Refund value over time" subtitle={`Settled customer refunds per day · ${chartCurrency || ""}`}>
              <div className="rl-chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trend} margin={{ top: 8, right: 12, left: 2, bottom: 0 }}>
                    <defs>
                      <linearGradient id="rlRefund" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={CHART.red} stopOpacity={0.22} />
                        <stop offset="100%" stopColor={CHART.red} stopOpacity={0.01} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={CHART.grid} vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: CHART.axis }} axisLine={{ stroke: CHART.axisLine }} tickLine={false} minTickGap={16} tickMargin={7} />
                    <YAxis tick={{ fontSize: 10, fill: CHART.axis }} axisLine={false} tickLine={false} width={50} tickFormatter={(v) => compactNumber(v, chartCurrency)} />
                    <Tooltip cursor={{ stroke: CHART.axis, strokeWidth: 1, strokeDasharray: "3 3" }} content={(p) => (
                      <ChartTooltip {...p} rows={(pt) => [
                        { key: "refund", label: "Refunds", value: fmtMoney(pt.refund, chartCurrency), color: CHART.red },
                        { key: "fees", label: "Return fees", value: fmtMoney(pt.fees, chartCurrency) },
                      ]} />
                    )} />
                    <Area type="monotone" dataKey="refund" stroke={CHART.red} strokeWidth={2} fill="url(#rlRefund)" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>

            <ChartCard title="Return rate over time" subtitle={`Returns ÷ ordered units per day · ${chartCurrency || ""}`}>
              <div className="rl-chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trend} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                    <CartesianGrid stroke={CHART.grid} vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: CHART.axis }} axisLine={{ stroke: CHART.axisLine }} tickLine={false} minTickGap={16} tickMargin={7} />
                    <YAxis tick={{ fontSize: 10, fill: CHART.axis }} axisLine={false} tickLine={false} width={40} tickFormatter={(v) => `${Math.round(v)}%`} />
                    <Tooltip cursor={{ stroke: CHART.axis, strokeWidth: 1, strokeDasharray: "3 3" }} content={(p) => (
                      <ChartTooltip {...p} rows={(pt) => [
                        pt.returnRate == null ? { key: "rate", label: "Return rate", value: "— (no ordered units)" } : { key: "rate", label: "Return rate", value: fmtRate(pt.returnRate), color: CHART.gold },
                        { key: "ret", label: "Returns / ordered", value: `${nInt(pt.returnCount)} / ${nInt(pt.orderedUnits)}` },
                      ]} />
                    )} />
                    <Line type="monotone" dataKey="returnRate" stroke={CHART.gold} strokeWidth={2} dot={false} connectNulls={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>

            <ChartCard title="Net impact over time" subtitle={`Refunds + return fees per day · ${chartCurrency || ""}`}>
              <div className="rl-chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trend} margin={{ top: 8, right: 12, left: 2, bottom: 0 }}>
                    <defs>
                      <linearGradient id="rlImpact" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={CHART.primary} stopOpacity={0.22} />
                        <stop offset="100%" stopColor={CHART.primary} stopOpacity={0.01} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={CHART.grid} vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: CHART.axis }} axisLine={{ stroke: CHART.axisLine }} tickLine={false} minTickGap={16} tickMargin={7} />
                    <YAxis tick={{ fontSize: 10, fill: CHART.axis }} axisLine={false} tickLine={false} width={50} tickFormatter={(v) => compactNumber(v, chartCurrency)} />
                    <Tooltip cursor={{ stroke: CHART.axis, strokeWidth: 1, strokeDasharray: "3 3" }} content={(p) => (
                      <ChartTooltip {...p} rows={(pt) => [
                        { key: "leak", label: "Leakage", value: fmtMoney(pt.leakage, chartCurrency), color: CHART.primary },
                        { key: "net", label: "Net impact", value: fmtMoney(pt.netImpact, chartCurrency) },
                      ]} />
                    )} />
                    <Area type="monotone" dataKey="leakage" stroke={CHART.primary} strokeWidth={2} fill="url(#rlImpact)" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>
          </div>
        )}

        {/* Portfolio breakdowns (windowed) */}
        {hasSeries && (
          <>
            {selectedBrand !== "ALL" && (
              <Notice tone="info">These portfolio breakdowns cover the account's authorized scope for the selected window; the product table below is narrowed to <strong>{selectedBrand}</strong>.</Notice>
            )}
            <div className="rl-breakdowns">
              <SegmentBar title="By return reason" subtitle="Reason buckets over the selected window" segments={reasonSeg} />
              <SegmentBar title="By fulfilment channel" subtitle="FBA vs FBM returns over the selected window" segments={channelSeg} />
              <SegmentBar title="By request status" subtitle="Settled vs pending / provisional over the selected window" segments={statusSeg} />
              <SegmentBar title="By return-label payer" subtitle="Who paid the return shipping label" segments={payerSeg} />
            </div>
          </>
        )}

        {/* Useful Actions */}
        <PriorityActions
          insights={insights}
          title="Useful Actions"
          mixedCurrency={money.mixed}
          onExport={exportInsights}
          exportDisabled={!insights.length}
          emptyNote="No product lost enough to returns in this window to justify an action."
        />

        {/* Advanced table */}
        <div className="panel skupl-table-panel" style={{ padding: 0, overflow: "hidden" }}>
          <div className="skupl-toolbar" style={{ flexWrap: "wrap", gap: 8 }}>
            <SearchField value={search} onChange={setSearch} placeholder="ASIN, SKU, product, brand, or reason" />
            <SelectField
              label="Dominant cause"
              value={bucketFilter}
              onChange={setBucketFilter}
              options={[
                { value: "ALL", label: `All causes (${rows.length})` },
                ...Object.entries(RETURN_BUCKET_META).map(([key, meta]) => ({ value: key, label: `${meta.label} (${bucketCounts[key] || 0})` })),
              ]}
            />
            <SelectField
              label="Show"
              value={viewFilter}
              onChange={setViewFilter}
              options={[
                { value: "ALL", label: "All products" },
                { value: "HIGH_RATE", label: "High return rate (≥15%)" },
                { value: "PROVISIONAL", label: "Has provisional returns" },
                { value: "UNMATCHED", label: "Returns without settlement" },
              ]}
            />
            <div className="skupl-toolbar-spacer" />
            <button type="button" className="cache-refresh-btn" onClick={exportXlsx} disabled={!sorted.length} title={sorted.length ? "Download Excel (.xlsx)" : "Nothing to export yet"}><FileSpreadsheet size={14} />Excel</button>
            <ExportButton onClick={exportCsv} disabled={!sorted.length} label="Download CSV" />
          </div>
          <div className="plan-scroll">
            <table className="plan-table rl-table" style={{ minWidth: 340 + visibleCols.length * 118 }}>
              <thead>
                <tr>
                  <SortTh className="pt-id" label="Product / ASIN" col="productName" sort={sort} onSort={onSort} align="left" />
                  {visibleCols.map((c) => (c.sortKey
                    ? <SortTh key={c.key} className={c.key === "reason" ? "returns-reason" : ""} label={c.label} col={c.sortKey} sort={sort} onSort={onSort} align={c.align || "right"} hint={c.hint} />
                    : <th key={c.key} className={c.align === "left" ? "pt-left" : ""} title={c.hint}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => {
                  const key = `${r.currency || "na"}|${r.asin}`;
                  const cur = r.currency || currency;
                  const isOpen = expanded === key;
                  return (
                    <React.Fragment key={key}>
                      <tr className={r.returnRate != null && r.returnRate >= 15 ? "plan-restock" : ""}>
                        <td className="pt-id">
                          <div className="rl-id-wrap">
                            <button type="button" className="rl-expand-btn" aria-expanded={isOpen} title={isOpen ? "Hide evidence" : "Show evidence"} onClick={() => setExpanded(isOpen ? null : key)}>
                              {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                            <div style={{ minWidth: 0 }}>
                              <div className="pt-name" title={r.productName || r.asin}>{r.productName || "(no product name)"}</div>
                              <div className="pt-meta mono">{r.asin}{r.sku ? ` · ${r.sku}` : ""}{r.currency ? ` · ${r.currency}` : ""}</div>
                              {r.brand && <div className="pt-brand">{r.brand}</div>}
                            </div>
                          </div>
                        </td>
                        {visibleCols.map((c) => (
                          <td key={c.key} className={c.key === "reason" ? "returns-reason" : (c.align === "left" ? "pt-left" : "")}>
                            {cellFor(c.key, r, cur).display}
                          </td>
                        ))}
                      </tr>
                      {isOpen && (
                        <tr>
                          <td className="rl-drill-cell" colSpan={1 + visibleCols.length}>
                            <DrillDetail r={r} cur={cur} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!pageRows.length && <div className="empty-note" style={{ padding: "14px 16px" }}>{rows.length ? "No products match these filters." : "No returns or refund settlements were reported for this scope in the window."}</div>}
          <Pagination page={safePage} pageCount={pageCount} onChange={setPage} />
        </div>

        {/* Freshness & completeness */}
        {fresh && (
          <div className="panel" style={{ marginTop: "var(--space-4)" }}>
            <div className="panel-title">Data freshness &amp; completeness</div>
            <div className="page-sub">When each source last refreshed, what it covers, and the provisional (awaiting-settlement) period.</div>
            <div className="rl-fresh-grid">
              <div className="rl-fresh-row"><span>Returns source refreshed</span><b>{stamp(fresh.returnsRefreshedAt)}</b></div>
              <div className="rl-fresh-row"><span>Settlements refreshed</span><b>{stamp(fresh.settlementsRefreshedAt)}</b></div>
              <div className="rl-fresh-row"><span>Returns coverage</span><b>{fmtDateHuman(fresh.returnsCoveredFrom)} – {fmtDateHuman(fresh.returnsCoveredTo)}</b></div>
              <div className="rl-fresh-row"><span>Settlements coverage</span><b>{fmtDateHuman(fresh.settlementsCoveredFrom)} – {fmtDateHuman(fresh.settlementsCoveredTo)}</b></div>
              <div className="rl-fresh-row"><span>Latest return / settlement</span><b>{fmtDateHuman(fresh.latestReturnDate)} / {fmtDateHuman(fresh.latestSettlementDate)}</b></div>
              <div className="rl-fresh-row"><span>Latest full reconciliation</span><b>{fresh.latestReconciliation ? fmtDateHuman(fresh.latestReconciliation) : "—"}</b></div>
              <div className="rl-fresh-row"><span>Provisional period</span><b>{fresh.provisionalFrom ? `${fmtDateHuman(fresh.provisionalFrom)} – ${fmtDateHuman(data.asOf || fresh.latestDataDate)}` : "—"}{fresh.graceDays != null ? ` (${fresh.graceDays}d grace)` : ""}</b></div>
              <div className="rl-fresh-row"><span>Latest data date</span><b>{fmtDateHuman(data.latestDataDate || fresh.latestDataDate)}</b></div>
            </div>
          </div>
        )}

        <div className="footer-note">
          Ranking is by <strong>money, not percentage</strong>: a high-volume product with a modest return rate outranks a tiny one with a scary rate. Total Leakage = settled customer refunds + seller-borne return fees, where return fees = return commission + the FBA customer-return per-unit fee − restocking recovered, <strong>clamped once</strong> over the selected window (never per day). Net impact subtracts the referral fee Amazon credits back. <code>COGS on refunded units</code> is displayed but deliberately excluded from leakage, because the source does not report whether returned stock came back sellable. Return rate is the returns-record count ÷ ordered units over the same window, recomputed from summed counts and <strong>withheld</strong> (—) when the row is currency-ambiguous, has no ordered units, or is lag-inflated (more returns than orders in the window). Reason buckets come from <code>amazon_return_reason</code> over the full return history; a cause is named only when one bucket is at least half of a product's returns. {hasSeries ? `Changing the window recomputes every figure, chart and comparison locally from the saved daily history — no export.` : ""} Currencies are never combined. Every filter, search, sort, page, column choice, window choice and both exports are local; this report never calls DataDoe.
        </div>
      </>}
    </div>
  );
}
