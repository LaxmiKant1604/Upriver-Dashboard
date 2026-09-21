// Daily Reporting -- the redesigned content area (flat Amazon operational system, approved Stitch redesign).
// Presentational only: every number comes from the `report` ({ latest, columns, cells }) App.jsx already builds from
// the saved payload, and the ratio rows come from the LOCKED business formulas in DAILY_METRICS / daily-view-model.
// Nothing here fetches, aggregates, or falls back across account/brand; the shared sidebar + top bar are untouched.
// White cards on a neutral workspace, #D5D9D9 hairlines, semantic accents (blue #146EB4, orange #FF9900, green
// #067D62, red #B12704), tabular numerals, no gradients, no violet theme. Icons are Lucide (no emoji). 7-bit ASCII.

import React, { useMemo, useState } from "react";
import { AlertTriangle, Info, RefreshCw, DatabaseZap, ChevronDown } from "lucide-react";
import { Sparkline, DataQualityAlert, EmptyState, SkeletonTable } from "../components/ui.jsx";
import { fmtMoney, fmtMoneyCompact, fmtDateHuman } from "../lib/format.js";
import { dailyMtdKpis, dailyTrendSeries, lastFinite, dailyCompletenessLabel, mtdColumnIndex } from "../lib/daily-view-model.js";

const DASH = "—"; // em dash -- the honest "unavailable" marker (never a fabricated zero)

// Per-metric identity colour for the row bullet + trend sparkline. The Ad Sales key uses a single restrained slate
// (#6B5B95) exactly as the approved reference specifies -- a desaturated secondary, distinct from the retired Royal
// Violet accents. Presentation only: no metric, value, or formula is affected.
const BULLET = {
  sales: "#146EB4", adSales: "#6B5B95", adSpend: "#FF9900", clicks: "#565959",
  units: "#067D62", roi: "#067D62", acos: "#FF9900", tacos: "#146EB4",
};

// The six MTD KPI cards, in design order. `accent` is the 2px semantic top keyline; `cap` is the footer caption. For
// money cards the footer shows the same MTD figure at full precision; for ratio cards it shows the REAL locked
// formula (never the reference mock's incorrect "(Sales - Spend) / Spend" or its fabricated "Healthy" verdicts).
const KPI_META = {
  sales:   { label: "Total Sales MTD", accent: "blue",   cap: "Month-to-date total" },
  adSales: { label: "Ad Sales MTD",    accent: "blue",   cap: "Attributed same-SKU sales" },
  adSpend: { label: "Ad Spend MTD",    accent: "orange", cap: "Month-to-date ad spend" },
  roi:     { label: "ROI",             accent: "green",  cap: "Total Sales / Ad Spend", valueClass: "dr-kpi-value--roi" },
  acos:    { label: "ACoS %",          accent: "orange", cap: "Ad Spend / Ad Sales" },
  tacos:   { label: "TACoS %",         accent: "blue",   cap: "Ad Spend / Total Sales" },
};

const RATIO_KEYS = new Set(["roi", "acos", "tacos"]);

// The five observed-unit cells (DR-scoped -- the shared ObservedUnitsBreakdown is left for the other reports). Values,
// labels, and the inclusion/exclusion note read straight from `completeness.unitBreakdown`; nothing is recomputed.
function DrObservedUnits({ completeness }) {
  const b = completeness && completeness.unitBreakdown;
  if (!b) return null;
  const nf = (v) => (Number(v) || 0).toLocaleString("en-US");
  const priced = Number(b.pricedUnits) || 0;
  const observed = Number(b.observedUnits) || 0;
  const coverage = observed > 0 ? (priced / observed) * 100 : null; // a plain restatement (priced of observed)
  const status = completeness.provisional ? "Provisional" : (completeness.sourceDefect ? "Source issue" : "Final");
  const cells = [
    { key: "priced", tone: "pos",  label: "Priced Units",       value: b.pricedUnits,           sub: coverage != null ? `${coverage.toFixed(1)}% coverage` : "Counted in revenue" },
    { key: "zero",   tone: "mute", label: "Explicit Zero-Price", value: b.explicitZeroUnits,     sub: "Promotions / free" },
    { key: "psku",   tone: "warn", label: "Pending – Has SKU", value: b.pendingWithSkuUnits, sub: "Catalog price mapped" },
    { key: "pnosku", tone: "mute", label: "Pending – No SKU", value: b.pendingWithoutSkuUnits, sub: "Unallocated order lines" },
    { key: "canc",   tone: "neg",  label: "Cancelled",          value: b.cancelledUnits,          sub: "Filtered from net totals" },
  ];
  return (
    <div className="dr-obs" role="group" aria-label="Observed unit breakdown">
      <div className="dr-obs-head">
        <span className="dr-obs-title">Observed Units Breakdown{b.onDate ? ` (${b.onDate})` : ""}</span>
        <span className="dr-obs-total">Total: <strong>{nf(b.observedUnits)} units</strong> observed &middot; {nf(b.skuMovementUnits)} in SKU Movement ({status})</span>
      </div>
      <div className="dr-obs-grid">
        {cells.map((cell) => (
          <div key={cell.key} className={"dr-obs-cell dr-obs-cell--" + cell.tone}>
            <div className="dr-obs-cell-label">{cell.label}</div>
            <div className="dr-obs-cell-value">{nf(cell.value)}</div>
            <div className="dr-obs-cell-sub">{cell.sub}</div>
          </div>
        ))}
      </div>
      <div className="dr-obs-note">
        Revenue counts priced units only &mdash; explicit zero-price and pending-price units add no sales. Explicit-zero and
        SKU-identifiable pending units are included in unit movement; unallocated pending units (no SKU/ASIN yet) are not.
        {completeness.finalizedThrough ? ` Fully finalized through ${completeness.finalizedThrough}.` : ""} Values reconcile automatically on later order refreshes.
      </div>
    </div>
  );
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
  const [showCoverage, setShowCoverage] = useState(true); // observed-units disclosure, expanded by default

  const moneyC = (v) => (v === null || v === undefined ? DASH : fmtMoneyCompact(v, currency));
  const moneyF = (v) => (v === null || v === undefined ? DASH : fmtMoney(v, currency));

  // The six KPI cards, values straight from the MTD column (adSales/adSpend are null -> em dash when advertising is
  // unavailable, never a fabricated zero). Money footers carry the full-precision figure; ratio footers the formula.
  const cards = kpis ? [
    { key: "sales",   ...KPI_META.sales,   big: moneyC(kpis.totalSales), val: moneyF(kpis.totalSales), partial: !!kpis.salesPartial },
    { key: "adSales", ...KPI_META.adSales, big: moneyC(kpis.adSales),    val: moneyF(kpis.adSales) },
    { key: "adSpend", ...KPI_META.adSpend, big: moneyC(kpis.adSpend),    val: moneyF(kpis.adSpend) },
    { key: "roi",     ...KPI_META.roi,     big: kpis.roi,   val: null },
    { key: "acos",    ...KPI_META.acos,    big: kpis.acos,  val: null },
    { key: "tacos",   ...KPI_META.tacos,   big: kpis.tacos, val: null },
  ] : [];

  // Column emphasis: the MTD column is found dynamically; the latest completed day is the last "day" column.
  const cols = (report && report.columns) || [];
  const mtdIdx = mtdColumnIndex(report);
  let latestIdx = -1;
  cols.forEach((c, i) => { if (c && c.group === "day") latestIdx = i; });
  const colClass = (i, c) => (i === mtdIdx ? "mtd" : i === latestIdx ? "latest" : (c.group || "day"));

  // The four 5-day trend cards, from the exact daily series the table shows (honest gaps stay null). The date range is
  // the real first/last day labels; the secondary line restates the latest value at full precision.
  const trendDefs = [
    { key: "sales",   label: "Total Sales Trend (5 days)", color: BULLET.sales,   fmt: moneyC, subFmt: moneyF },
    { key: "adSales", label: "Ad Sales Trend (5 days)",    color: BULLET.adSales, fmt: moneyC, subFmt: moneyF },
    { key: "roi",     label: "ROI Trend (5 days)",         color: BULLET.roi,     fmt: (v) => v.toFixed(2),        subFmt: (v) => v.toFixed(2) },
    { key: "acos",    label: "ACoS % Trend (5 days)",      color: BULLET.acos,    fmt: (v) => v.toFixed(1) + "%",  subFmt: (v) => v.toFixed(1) + "%" },
  ].map((t) => ({ ...t, series: trends[t.key] || [] }));
  const trendLabels = trends.labels || [];
  const trendRange = trendLabels.length ? `${trendLabels[0]} → ${trendLabels[trendLabels.length - 1]}` : "";

  // Consolidated status: source issue (error) > provisional (warning) > final (info). Every real message is preserved
  // with its severity; error stays the most prominent tone. The advertising-coverage note is a separate info panel.
  const c = completeness;
  const statusTone = c ? (c.sourceDefect ? "error" : c.provisional ? "warning" : "final") : null;
  const statusTitle = c
    ? (c.sourceDefect
        ? "Source-data issue for D-1"
        : c.provisional
          ? `Provisional D-1 — ${c.itemizationPercent}% of orders itemized`
          : `Final D-1${c.finalizedThrough ? ` — finalized through ${fmtDateHuman(c.finalizedThrough)}` : ""}`)
    : null;
  const statusDetail = c
    ? (c.sourceDefect
        ? c.notice
        : c.provisional
          ? `${c.notice} (${c.pendingOrderCount} order(s)${c.pendingUnitCount ? `, ${c.pendingUnitCount} unit(s)` : ""} pending item-level prices${c.finalizedThrough ? `; last fully finalized day: ${fmtDateHuman(c.finalizedThrough)}` : ""}.)`
          : "Sales for this window are fully itemized; pending item-level prices have all reconciled.")
    : null;
  const showStatus = Boolean(c && (c.provisional || c.sourceDefect || c.unitBreakdown || c.finalizedThrough || c.itemizationPercent != null));

  const ads = report && report.adsAvailability && report.adsAvailability.provisionalFrom ? report.adsAvailability : null;
  const adsRecorded = ads && ads.recordedThrough;

  return (
    <div className="container dr-page op-report">
      {/* Heading -- existing title + dynamic account/brand/currency subtitle (compact, no title card) */}
      <div className="controls-bar">
        <div>
          <div className="page-title">Daily Reporting</div>
          <div className="page-sub">Sales &amp; advertising snapshot for {scopeName}{scopeSuffix} &middot; reported in {currency}</div>
        </div>
      </div>

      {/* Honest load error / not-yet-available state (behaviour unchanged) */}
      {error && (missing
        ? <DataQualityAlert tone="info" title="This report is not available yet" detail={error} />
        : <DataQualityAlert tone="error" title="The last refresh failed" detail={error} />)}

      {/* Consolidated data-status panel with a price-coverage disclosure */}
      {showStatus && (
        <section className={"dr-status dr-status--" + statusTone}>
          <div className="dr-status-row">
            <span className="dr-status-icon" aria-hidden="true">{statusTone === "final" ? <Info size={16} /> : <AlertTriangle size={16} />}</span>
            {/* The live region is the status MESSAGE only -- toggling the coverage disclosure below must not
                re-announce the whole panel, and this avoids a live region nested inside another. */}
            <div className="dr-status-main" role={statusTone === "error" ? "alert" : "status"}>
              <div className="dr-status-line">
                {badge && <span className={"dr-status-badge dr-status-badge--" + badge.tone}>{badge.label}</span>}
                <span className="dr-status-title">{statusTitle}</span>
              </div>
              {statusDetail && <div className="dr-status-detail">{statusDetail}</div>}
            </div>
            {c.unitBreakdown && (
              <button type="button" className="dr-status-toggle" aria-expanded={showCoverage} onClick={() => setShowCoverage((v) => !v)}>
                <span>{showCoverage ? "Hide price coverage details" : "View price coverage details"}</span>
                <ChevronDown size={14} className={"dr-status-chevron" + (showCoverage ? " is-open" : "")} aria-hidden="true" />
              </button>
            )}
          </div>
          {c.unitBreakdown && showCoverage && <DrObservedUnits completeness={c} />}
        </section>
      )}

      {/* ADVERTISING DATA-STATE HONESTY: a covered day with no recorded ad row is UNKNOWN, never a measured zero. We
          report only the FACTUAL recorded extent; days without a recorded row are shown as unavailable (em dash). No
          export is created; they resolve on their own as the provider reports them. */}
      {ads && (
        <section className="dr-status dr-status--info">
          <div className="dr-status-row">
            <span className="dr-status-icon" aria-hidden="true"><Info size={16} /></span>
            <div className="dr-status-main" role="status">
              <div className="dr-status-line">
                <span className="dr-status-title">
                  {adsRecorded
                    ? `Advertising recorded for ${typeof ads.recordedDayCount === "number" && typeof ads.coveredDayCount === "number" ? `${ads.recordedDayCount} of ${ads.coveredDayCount} covered days` : "part of the covered window"}`
                    : "Advertising not yet recorded for the covered window"}
                </span>
              </div>
              <div className="dr-status-detail">
                {adsRecorded
                  ? <>Recorded ad data spans {fmtDateHuman(ads.recordedFrom)} &ndash; {fmtDateHuman(ads.recordedThrough)}. The other covered days have no recorded ad activity &mdash; the provider has not validated their completeness, so we cannot tell a genuine zero from data not yet reported. Ad spend and TACoS for those days are shown as unavailable (&mdash;), never a measured zero. No export is created; they resolve on their own as the provider reports them.</>
                  : <>This window was covered by a successful sync but carries no recorded advertising data yet, and its completeness is not validated by the provider &mdash; we cannot tell genuine zero activity from data not yet reported, so ad spend and TACoS are shown as unavailable (&mdash;), never a measured zero. No export is created; they resolve on their own as the provider reports them.</>}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Six MTD KPI cards -- white, hairline border, 2px semantic top accent */}
      {hasData && cards.length > 0 && (
        <div className="dr-kpis">
          {cards.map((card) => (
            <div key={card.key} className={"dr-kpi dr-kpi--" + card.accent}>
              <div>
                <div className="dr-kpi-label">
                  {card.label}
                  {card.partial && (
                    <span
                      title="This month's OLI coverage is partial; the total is source-backed for the covered dates only -- some dates are unavailable, not zero."
                      style={{ display: "inline-block", marginLeft: 6, padding: "1px 6px", borderRadius: 8, fontSize: 10, fontWeight: 600, letterSpacing: 0.2, background: "rgba(245,158,11,0.14)", border: "1px solid rgba(245,158,11,0.32)", color: "var(--amber-800, #92400e)", verticalAlign: "middle" }}
                    >
                      Partial
                    </span>
                  )}
                </div>
                <div className={"dr-kpi-value" + (card.valueClass ? " " + card.valueClass : "")}>{card.big}</div>
              </div>
              <div className="dr-kpi-foot">
                <span className="dr-kpi-cap">{card.cap}</span>
                {card.val !== null && <span className="dr-kpi-subval">{card.val}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Main reporting matrix */}
      <div className="dr-card">
        <div className="dr-card-head">
          <div className="dr-card-head-main">
            <div className="dr-card-titlerow">
              <h2 className="dr-card-title">{scopeName}{scopeSuffix}</h2>
              {badge && <span className={"dr-card-badge dr-card-badge--" + badge.tone}>{badge.label}</span>}
            </div>
            <div className="dr-card-meta">
              {hasData ? (
                <>
                  {completeness && completeness.provisional && (
                    <span>{completeness.itemizationPercent}% itemized &middot; {completeness.pendingOrderCount} orders pending{completeness.pendingUnitCount ? ` (${completeness.pendingUnitCount} units)` : ""}</span>
                  )}
                  {completeness && completeness.finalizedThrough && <span>&middot; finalized through {fmtDateHuman(completeness.finalizedThrough)}</span>}
                  <span>&middot; latest completed sales: <strong>{fmtDateHuman(report.latest)}</strong></span>
                  <span>&middot; figures shown in <strong>{currency}</strong></span>
                </>
              ) : (
                <span>Reported in {currency}</span>
              )}
            </div>
          </div>
          <button className="dr-refresh" onClick={onReload} disabled={loading} title="Reload the latest saved data (no DataDoe export)" aria-label="Refresh Data">
            <RefreshCw size={14} className={loading ? "spin" : ""} aria-hidden="true" />
            <span>Refresh Data</span>
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
                  <th scope="col" className="dr-th dr-th-metric">Metric / Measure</th>
                  {cols.map((col, i) => {
                    const cc = colClass(i, col);
                    // OLI coverage badge (flexii UK follow-up): a column whose OLI coverage is not fully proven is
                    // labelled so its Total Sales / Units are never read as a fully-available figure. Partial shows the
                    // covered date range (source-backed total for those dates only); unavailable/unknown are shown as
                    // such -- never as a zero. A fully-covered column (incl. a genuine covered zero) carries no badge.
                    const cell = report.cells[i] || {};
                    const st = cell.status;
                    const cov = st === "partial"
                      ? { label: "Partial", title: `Only ${cell.provenDays} of ${cell.totalDays} days in this column are source-covered; the total is source-backed for those dates, and some dates in this range are unavailable, not zero.` }
                      : st === "unavailable"
                        ? { label: "Unavailable", title: "No source coverage for this period — shown as unavailable, never as a zero." }
                        : st === "unknown"
                          ? { label: "Unknown", title: "Coverage evidence could not be read for this period." }
                          : null;
                    return (
                      <th key={col.key} scope="col" className={"dr-th dr-th-" + cc}>
                        {col.label}
                        {i === latestIdx && <span className="dr-th-tag">Latest</span>}
                        {cov && (
                          <span
                            className="dr-th-cov"
                            title={cov.title}
                            style={{ display: "inline-block", marginLeft: 6, padding: "1px 6px", borderRadius: 8, fontSize: 10, fontWeight: 600, letterSpacing: 0.2, background: "rgba(245,158,11,0.14)", border: "1px solid rgba(245,158,11,0.32)", color: "var(--amber-800, #92400e)", verticalAlign: "middle" }}
                          >
                            {cov.label}
                          </span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {metrics.map((metric) => {
                  const isRatio = RATIO_KEYS.has(metric.key);
                  return (
                    <React.Fragment key={metric.key}>
                      {metric.key === "roi" && (
                        <tr className="dr-section-row">
                          <td colSpan={cols.length + 1}>Operational ratios &amp; margins</td>
                        </tr>
                      )}
                      <tr className={"dr-tr" + (isRatio ? " dr-tr-ratio" : "")}>
                        <td className="dr-td dr-td-metric">
                          <span className="dr-bullet" style={{ background: BULLET[metric.key] || "#565959" }} aria-hidden="true" />
                          <span className="dr-metric-label">{metric.label}</span>
                        </td>
                        {cols.map((col, i) => {
                          const cell = report.cells[i];
                          const text = metric.fmt(cell, currency);
                          const isDash = text === DASH;
                          const cc = colClass(i, col);
                          return (
                            <td key={col.key} className={"mono dr-td dr-td-" + cc}>
                              {isDash ? <span className="dr-dash">{DASH}</span> : text}
                            </td>
                          );
                        })}
                      </tr>
                    </React.Fragment>
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
                <div className="dr-trend-head">
                  <span className="dr-trend-label">{t.label}</span>
                  {trendRange && <span className="dr-trend-range">{trendRange}</span>}
                </div>
                <div className="dr-trend-body">
                  <div className="dr-trend-figs">
                    <div className="dr-trend-value" style={{ color: t.color }}>{latest === null ? DASH : t.fmt(latest)}</div>
                    <div className="dr-trend-sub">{latest === null ? "No data in range" : `Latest: ${t.subFmt(latest)}`}</div>
                  </div>
                  <div className="dr-trend-spark"><Sparkline values={t.series} color={t.color} height={36} ariaLabel={t.label} /></div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Methodology & metric definitions -- accessible disclosure; the real locked formulas are preserved */}
      <details className="methodology-disclosure dr-methodology">
        <summary>Data methodology and metric definitions</summary>
        <div className="dr-method-grid">
          <div className="dr-method-col">
            <div className="dr-method-h">Calculation formulas</div>
            <ul>
              <li><strong>ROI</strong> = Total Sales &divide; Ad Spend</li>
              <li><strong>ACoS %</strong> = Ad Spend &divide; Ad Sales</li>
              <li><strong>TACoS %</strong> = Ad Spend &divide; Total Sales</li>
            </ul>
          </div>
          <div className="dr-method-col">
            <div className="dr-method-h">Data attribution &amp; sources</div>
            <p>
              Sales and ordered units are sourced from DataDoe Order Line Items (<code>item_price_value / quantity</code>).{" "}
              {selectedBrand === "ALL"
                ? "Ad Sales, Ad Spend, and Clicks are sourced from the saved ASIN advertising data (same-SKU attributed sales)."
                : "Advertising metrics for this brand are the saved ASIN advertising rows whose ASIN maps to the brand through the Product Catalog (same-SKU attributed sales); ads on ASINs without a catalog brand mapping are not attributed."}
            </p>
          </div>
          <div className="dr-method-col">
            <div className="dr-method-h">Reconciliation &amp; coverage policy</div>
            <p>
              The report ends on the latest completed sales date so a delayed source row is not shown as a real zero-sales day.
              An em dash means advertising coverage is unavailable for that period, never a measured zero. Opening or reloading
              this report reads saved data only and never calls DataDoe.
            </p>
          </div>
        </div>
      </details>
    </div>
  );
}
