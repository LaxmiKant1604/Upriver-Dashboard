// Daily Reporting -- the redesigned content area (Royal Violet system). Presentational only: every number comes from
// the `report` ({ latest, columns, cells }) App.jsx already builds from the saved payload, and the ratio rows come
// from the LOCKED business formulas in DAILY_METRICS / daily-view-model. Nothing here fetches, aggregates, or falls
// back across account/brand; the shared sidebar + top bar are untouched. Icons are Lucide (no emoji). 7-bit ASCII.

import React, { useMemo } from "react";
import {
  Wallet, Megaphone, BarChart3, MousePointerClick, Boxes, TrendingUp, Target, Percent,
  RefreshCw, Info, DatabaseZap,
} from "lucide-react";
import { Sparkline, DataQualityAlert, EmptyState, ObservedUnitsBreakdown, SkeletonTable } from "../components/ui.jsx";
import { fmtMoneyCompact, fmtDateHuman } from "../lib/format.js";
import { dailyMtdKpis, dailyTrendSeries, lastFinite, dailyCompletenessLabel } from "../lib/daily-view-model.js";

// Per-row identity for the table (icon + accent). Colours mirror the design's row accents and the KPI gradients.
// Restrained per-metric accent keys in the operational palette (steel / emerald /
// amber / coral) so the icon chips, MTD accents and trend keys match the premium
// Sales Dashboard. Presentation only -- no metric, value or formula changes.
const METRIC_META = {
  sales:   { color: "#2F6FB0", Icon: Wallet },
  adSales: { color: "#5B8DB8", Icon: Megaphone },
  adSpend: { color: "#E08600", Icon: BarChart3 },
  clicks:  { color: "#7C9FC0", Icon: MousePointerClick },
  units:   { color: "#0E9F6E", Icon: Boxes },
  roi:     { color: "#0B7D5A", Icon: TrendingUp },
  acos:    { color: "#C97E12", Icon: Target },
  tacos:   { color: "#D6492E", Icon: Percent },
};

// The six MTD KPI cards, in design order. `bg` is the gradient; `text` is the pre-formatted value (currency-aware,
// em dash when unavailable -- never a fabricated zero).
function kpiCards(kpis, currency) {
  if (!kpis) return [];
  const money = (v) => (v === null || v === undefined ? "—" : fmtMoneyCompact(v, currency));
  return [
    { key: "sales",   label: "Total Sales MTD", text: money(kpis.totalSales), bg: "linear-gradient(135deg,#FF6B6B,#FF8E53)" },
    { key: "adSales", label: "Ad Sales MTD",    text: money(kpis.adSales),    bg: "linear-gradient(135deg,#A78BFA,#7C3AED)" },
    { key: "adSpend", label: "Ad Spends MTD",   text: money(kpis.adSpend),    bg: "linear-gradient(135deg,#F59E0B,#D97706)" },
    { key: "roi",     label: "ROI",             text: kpis.roi,               bg: "linear-gradient(135deg,#34D399,#059669)" },
    { key: "acos",    label: "ACoS %",          text: kpis.acos,              bg: "linear-gradient(135deg,#FBBF24,#D97706)" },
    { key: "tacos",   label: "TACoS %",         text: kpis.tacos,             bg: "linear-gradient(135deg,#F472B6,#DB2777)" },
  ];
}

export default function DailyReporting({
  accountName, selectedBrand, currency, report, rows, completeness,
  loading, error, missing, accountId, onReload, metrics,
}) {
  const kpis = useMemo(() => dailyMtdKpis(report), [report]);
  const trends = useMemo(() => dailyTrendSeries(report), [report]);
  const badge = dailyCompletenessLabel(completeness);
  const scopeName = accountName || "the selected account";
  const scopeSuffix = selectedBrand === "ALL" ? "" : ` · ${selectedBrand}`;
  const hasData = Array.isArray(rows) && rows.length > 0;
  const cards = kpiCards(kpis, currency);

  const trendDefs = [
    { key: "sales",   label: "Total Sales Trend (5 days)", color: "#FF6B6B", series: trends.sales,   fmt: (v) => fmtMoneyCompact(v, currency) },
    { key: "adSales", label: "Ad Sales Trend (5 days)",    color: "#A78BFA", series: trends.adSales, fmt: (v) => fmtMoneyCompact(v, currency) },
    { key: "roi",     label: "ROI Trend (5 days)",         color: "#34D399", series: trends.roi,     fmt: (v) => v.toFixed(2) },
    { key: "acos",    label: "ACoS % Trend (5 days)",      color: "#FBBF24", series: trends.acos,    fmt: (v) => v.toFixed(1) + "%" },
  ];

  return (
    <div className="container dr-page op-report">
      {/* Heading -- existing title + dynamic account/brand subtitle */}
      <div className="controls-bar">
        <div>
          <div className="page-title">Daily Reporting</div>
          <div className="page-sub">Sales &amp; advertising snapshot for {scopeName}{scopeSuffix}</div>
        </div>
      </div>

      {/* Honest error / not-yet-available states (behaviour unchanged) */}
      {error && (missing
        ? <DataQualityAlert tone="info" title="This report is not available yet" detail={error} />
        : <DataQualityAlert tone="error" title="The last refresh failed" detail={error} />)}

      {/* Two-layer PROVISIONAL D-1 as the full-width violet information band */}
      {completeness && completeness.provisional && (
        <div className="dr-band" role="status">
          <span className="dr-band-icon" aria-hidden="true"><Info size={16} /></span>
          <div>
            <div className="dr-band-title">Provisional D-1 &mdash; {completeness.itemizationPercent}% of orders itemized</div>
            <div className="dr-band-text">
              {completeness.notice} ({completeness.pendingOrderCount} order(s){completeness.pendingUnitCount ? `, ${completeness.pendingUnitCount} unit(s)` : ""} pending item-level prices{completeness.finalizedThrough ? `; last fully finalized day: ${fmtDateHuman(completeness.finalizedThrough)}` : ""}.)
            </div>
          </div>
        </div>
      )}
      {completeness && completeness.sourceDefect && (
        <DataQualityAlert tone="error" title="Source-data issue for D-1" detail={completeness.notice} />
      )}
      {completeness && completeness.unitBreakdown && <ObservedUnitsBreakdown completeness={completeness} />}

      {/* ADS DATA-STATE HONESTY (Items 3 + 4): there is NO durable per-date validated-completeness signal, so a
          covered day with no recorded ad row is NEVER claimed as a measured zero -- it is UNKNOWN. We report only the
          FACTUAL recorded-data extent (recordedFrom..recordedThrough, recorded of covered day counts). A day without a
          recorded row is shown as unavailable, not a confirmed zero. This makes no reporting-lag assumption and does
          not infer that a later metric completes earlier days. */}
      {report && report.adsAvailability && report.adsAvailability.provisionalFrom && (
        <div className="dr-band" role="status">
          <span className="dr-band-icon" aria-hidden="true"><Info size={16} /></span>
          <div>
            {report.adsAvailability.recordedThrough ? (
              <>
                <div className="dr-band-title">Advertising recorded for {typeof report.adsAvailability.recordedDayCount === "number" && typeof report.adsAvailability.coveredDayCount === "number" ? `${report.adsAvailability.recordedDayCount} of ${report.adsAvailability.coveredDayCount} covered days` : "part of the covered window"}</div>
                <div className="dr-band-text">
                  Recorded ad data spans {fmtDateHuman(report.adsAvailability.recordedFrom)} &ndash; {fmtDateHuman(report.adsAvailability.recordedThrough)}. The other covered days have no recorded ad activity &mdash; the provider has not validated their completeness, so we cannot tell a genuine zero from data not yet reported. Ad spend and TACoS for those days are shown as unavailable (&mdash;), never a measured zero. No export is created; they resolve on their own as the provider reports them.
                </div>
              </>
            ) : (
              <>
                <div className="dr-band-title">Advertising not yet recorded for the covered window</div>
                <div className="dr-band-text">
                  This window was covered by a successful sync but carries no recorded advertising data yet, and its completeness is not validated by the provider &mdash; we cannot tell genuine zero activity from data not yet reported, so ad spend and TACoS are shown as unavailable (&mdash;), never a measured zero. No export is created; they resolve on their own as the provider reports them.
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Six MTD KPI cards -- values straight from the report's MTD column */}
      {hasData && cards.length > 0 && (
        <div className="dr-kpis">
          {cards.map((c) => (
            <div key={c.key} className="dr-kpi" style={{ background: c.bg }}>
              <div className="dr-kpi-label">{c.label}</div>
              <div className="dr-kpi-value">{c.text}</div>
            </div>
          ))}
        </div>
      )}

      {/* Main reporting table card */}
      <div className="dr-card">
        <div className="dr-card-head">
          <div className="dr-card-head-main">
            <div className="dr-card-title">{scopeName}{scopeSuffix}</div>
            <div className="page-sub">
              {hasData
                ? `Latest completed sales: ${fmtDateHuman(report.latest)} · shown in ${currency}`
                : `Reported in ${currency}`}
            </div>
            {badge && (
              <div className="dr-card-meta">
                <span className={"dr-badge dr-badge-" + badge.tone}>{badge.label}</span>
                {completeness && completeness.provisional && (
                  <span>{completeness.itemizationPercent}% itemized &middot; {completeness.pendingOrderCount} orders pending{completeness.pendingUnitCount ? ` (${completeness.pendingUnitCount} units)` : ""}</span>
                )}
                {completeness && completeness.finalizedThrough && <span>&middot; finalized through {fmtDateHuman(completeness.finalizedThrough)}</span>}
              </div>
            )}
          </div>
          <button className="dr-refresh" onClick={onReload} disabled={loading} title="Reload the latest saved data (no DataDoe export)" aria-label="Reload Daily Reporting">
            <RefreshCw size={14} className={loading ? "spin" : ""} aria-hidden="true" />
          </button>
        </div>

        {loading && !hasData ? (
          <div className="dr-card-body"><SkeletonTable rows={8} /></div>
        ) : !hasData ? (
          <div className="dr-card-body">
            <EmptyState
              icon={<DatabaseZap size={19} aria-hidden="true" />}
              title={accountId ? "No data for this selection yet" : "No account selected"}
              actions={accountId ? (
                <button className="plan-export-btn" type="button" onClick={onReload} disabled={loading}>
                  <RefreshCw size={14} className={loading ? "spin" : ""} aria-hidden="true" />
                  Reload latest data
                </button>
              ) : null}
            >
              {accountId
                ? "This report is derived automatically from saved data the first time it is opened -- selecting a brand never waits for a schedule and never calls DataDoe. If this stays empty, the account has no rows for this selection or a required saved source is still missing."
                : "Choose an Amazon account in the command bar above."}
            </EmptyState>
          </div>
        ) : (
          <div className="dr-scroll">
            <table className="dr-table">
              <thead>
                <tr>
                  <th className="dr-th dr-th-metric">{(accountName && accountName.split(" ")[0]) || "Metric"}</th>
                  {report.columns.map((c) => (
                    <th key={c.key} className={"dr-th dr-th-" + c.group}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metrics.map((metric) => {
                  const meta = METRIC_META[metric.key] || METRIC_META.sales;
                  const Icon = meta.Icon;
                  return (
                    <tr key={metric.key} className={"dr-tr" + (metric.highlight ? " dr-row-highlight" : "")}>
                      <td className="dr-td dr-td-metric">
                        <span className="dr-ic" style={{ color: meta.color, background: meta.color + "1F" }} aria-hidden="true">
                          <Icon size={13} />
                        </span>
                        <span className="dr-metric-label">{metric.label}</span>
                      </td>
                      {report.cells.map((cell, i) => {
                        const group = report.columns[i].group;
                        const text = metric.fmt(cell, currency);
                        const isDash = text === "—";
                        const style = group === "mtd" && !isDash ? { color: meta.color } : undefined;
                        return (
                          <td key={report.columns[i].key} className={"mono dr-td dr-td-" + group}>
                            {isDash ? <span className="dr-dash">&mdash;</span> : <span style={style}>{text}</span>}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Four 5-day trend cards -- real latest-five values, honest gaps dropped */}
      {hasData && (
        <div className="dr-trends">
          {trendDefs.map((t) => {
            const latest = lastFinite(t.series);
            return (
              <div key={t.key} className="dr-trend">
                <div className="dr-trend-label">{t.label}</div>
                <div className="dr-trend-row">
                  <div className="dr-trend-value" style={{ color: t.color }}>{latest === null ? "—" : t.fmt(latest)}</div>
                  <div className="dr-trend-spark"><Sparkline values={t.series} color={t.color} height={34} ariaLabel={t.label} /></div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Formula / source note */}
      <div className="dr-note">
        <strong>ROI</strong> = Total Sales &divide; Ad Spend &middot; <strong>ACoS %</strong> = Ad Spend &divide; Ad Sales &middot; <strong>TACoS %</strong> = Ad Spend &divide; Total Sales.{" "}
        Sales and ordered units are sourced from DataDoe Order Line Items (<code>item_price_value / quantity</code>).{" "}
        {selectedBrand === "ALL"
          ? "Ad Sales, Ad Spend, and Clicks are sourced from the saved ASIN advertising data (same-SKU attributed sales)."
          : "Advertising metrics for this brand are the saved ASIN advertising rows whose ASIN maps to the brand through the Product Catalog (same-SKU attributed sales); ads on ASINs without a catalog brand mapping are not attributed. An em dash means advertising coverage is unavailable for that period, never a measured zero."}{" "}
        The report ends on the latest completed sales date so a delayed source row is not shown as a real zero-sales day.
      </div>
    </div>
  );
}
