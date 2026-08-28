// Presentation pieces shared by the six insight reports.
//
// These reuse the dashboard's existing class names (panel, plan-table,
// recon-freshness, plan-stat-row, pt-badge ...) so the new reports look like the
// rest of Upriver rather than a bolt-on, and inherit the existing mobile
// behaviour: the table scrolls inside its own container with a sticky identifier
// column and the page itself never scrolls sideways.

import React from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Download,
  Info,
  Search,
} from "lucide-react";

import { SEVERITY_LABEL } from "../lib/insights.js";
import { fmtMoney } from "../lib/format.js";

export function ReportHeader({ title, subtitle, children }) {
  return (
    <div className="controls-bar">
      <div>
        <div className="page-title">{title}</div>
        <div className="page-sub">{subtitle}</div>
      </div>
      {children}
    </div>
  );
}

/** The one-line data-provenance strip: what source, how fresh, when saved. */
export function FreshnessBar({ items }) {
  const parts = items.filter(Boolean);
  return (
    <div className="recon-freshness">
      <span className="live-dot" style={{ position: "relative", top: 1 }} />
      {parts.map((item, index) => (
        <React.Fragment key={index}>
          {index > 0 && <span className="plan-fresh-sep">·</span>}
          <span>{item}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

export function Notice({ tone = "info", children }) {
  if (tone === "error") {
    return <div className="error-banner"><AlertTriangle size={15} /> {children}</div>;
  }
  if (tone === "warn") {
    return (
      <div className="alert warning">
        <AlertTriangle size={15} /> {children}
      </div>
    );
  }
  return <div className="recon-notice"><Info size={15} /> {children}</div>;
}

export function StatRow({ stats }) {
  return (
    <div className="plan-stat-row">
      {stats.map((stat) => (
        <div className="plan-stat" key={stat.label} title={stat.hint || undefined}>
          <div className="plan-stat-label">{stat.label}</div>
          <div className={"plan-stat-value mono" + (stat.tone === "bad" ? " sku-neg" : stat.tone === "good" ? " sku-pos" : "")}>{stat.value}</div>
        </div>
      ))}
    </div>
  );
}

/** Sortable header cell. Same markup and behaviour as the FBA plan table. */
export function SortTh({ label, col, sort, onSort, align = "right", className = "", hint, style }) {
  const active = sort.key === col;
  return (
    <th
      className={`${className} ${align === "left" ? "pt-left" : ""} pt-sortable ${active ? "pt-sorted" : ""}`}
      onClick={() => onSort(col)}
      title={hint || "Click to sort"}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      style={style}
    >
      <span className="pt-th-inner">
        {label}
        {active ? (sort.dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="pt-th-idle" />}
      </span>
    </th>
  );
}

/** Product / ASIN / SKU identity cell used as the sticky first column. */
export function IdentityCell({ name, primary, secondary, brand }) {
  return (
    <td className="pt-id">
      <div className="pt-name" title={name || primary}>{name || "(no product name)"}</div>
      <div className="pt-meta mono">{primary}{secondary ? ` · ${secondary}` : ""}</div>
      {brand && <div className="pt-brand">{brand}</div>}
    </td>
  );
}

export function SearchField({ value, onChange, placeholder, label = "Search" }) {
  return (
    <label className="plan-field skupl-search">
      <span className="plan-field-label">{label}</span>
      <span className="plan-search-wrap">
        <Search size={14} />
        <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={placeholder || label} />
      </span>
    </label>
  );
}

export function SelectField({ label, value, onChange, options }) {
  return (
    <label className="plan-field">
      <span className="plan-field-label">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

export function ExportButton({ onClick, disabled, label = "Download Excel" }) {
  return (
    <button className="plan-export-btn" type="button" onClick={onClick} disabled={disabled} title={disabled ? "Nothing to export yet" : label}>
      <Download size={15} />
      {label}
    </button>
  );
}

export function EmptyPanel({ icon, children }) {
  return <div className="panel recon-empty">{icon}<div>{children}</div></div>;
}

/**
 * The shared "where does this data come from" state machine.
 *
 * Returns null when the report has data to render. Otherwise it renders exactly
 * one honest state: loading, an error, "no shared snapshot yet — press
 * Refresh", or a genuinely empty result. It never renders zeroes as if they
 * were measured.
 */
export function SnapshotState({ data, loading, error, label, icon }) {
  if (error) return <Notice tone="error">{error}</Notice>;
  if (loading && !data) return <EmptyPanel icon={icon}>Loading the saved {label} for this account…</EmptyPanel>;
  if (!data) return <EmptyPanel icon={icon}>Reading the saved {label} for this account…</EmptyPanel>;
  if (data.snapshotMissing) {
    return (
      <EmptyPanel icon={icon}>
        {data.message || `No saved ${label} for this account yet — waiting for the scheduled data refresh.`}
        <div className="page-sub" style={{ marginTop: 8 }}>
          This report updates automatically from saved data. DataDoe refreshes run on schedule or from the Data Sync Center — opening this page never calls DataDoe.
        </div>
      </EmptyPanel>
    );
  }
  return null;
}

/** Freshness/sharing strip describing the shared snapshot itself. */
export function snapshotFreshnessLabel(data) {
  if (!data?.snapshot) return data && data.shared === false ? "not shared — Supabase is not configured" : null;
  const saved = data.snapshot.savedAt ? new Date(data.snapshot.savedAt) : null;
  const stamp = saved ? saved.toLocaleString() : "at an unknown time";
  if (data.snapshot.staleScope) {
    const savedFor = data.snapshot.savedForParams?.to;
    return `shared snapshot saved ${stamp}${savedFor ? ` for as-of ${savedFor}` : ""} — refresh for today`;
  }
  return `shared snapshot saved ${stamp}`;
}

/**
 * A banner for a snapshot that was saved under an earlier as-of date. The report
 * is still real data, it is just not today's, and saying so plainly is better
 * than either hiding it or implying it is current.
 */
export function StaleScopeNotice({ data }) {
  if (!data?.snapshot?.staleScope) return null;
  const savedFor = data.snapshot.savedForParams?.to;
  const requested = data.snapshot.requestedParams?.to;
  return (
    <Notice tone="warn">
      Showing the last saved version of this report{savedFor ? `, which covers data as of ${savedFor}` : ""}
      {requested && savedFor && requested !== savedFor ? ` rather than ${requested}` : ""}. Every figure below is
      real and was fetched then — it is simply not today's. Press Refresh to fetch the current window and save it
      for everyone with access to this account.
    </Notice>
  );
}

/**
 * Money can only be totalled inside one currency.
 *
 * When a report's scope contains more than one currency, any combined money
 * figure is meaningless, so this returns `mixed: true` and callers render an em
 * dash instead of a number that silently adds rupees to dollars.
 */
export function moneyScope(data, fallbackCurrency) {
  const list = Array.isArray(data?.currencies) ? data.currencies.filter(Boolean) : [];
  if (list.length > 1) return { currency: null, mixed: true, currencies: list };
  return { currency: list[0] || fallbackCurrency || null, mixed: false, currencies: list };
}

/** Format a combined money total, or an em dash when currencies are mixed. */
export function totalMoney(value, scope, formatter) {
  if (scope.mixed) return "—";
  return formatter(value, scope.currency);
}

function SeverityBadge({ severity }) {
  const tone = severity === "high" ? "bad" : severity === "medium" ? "warn" : "ok";
  return <span className={"pt-badge sku-badge-" + tone}>{SEVERITY_LABEL[severity]}</span>;
}

export function InsightRow({ insight }) {
  return (
    <div className={"insight-row insight-" + insight.severity}>
      <div className="insight-head">
        <SeverityBadge severity={insight.severity} />
        <span className="insight-title" title={insight.title}>{insight.title}</span>
        <span className="insight-money mono">
          {insight.moneyAtRisk === null ? "—" : fmtMoney(insight.moneyAtRisk, insight.currency)}
        </span>
      </div>
      <div className="insight-why">{insight.why}</div>
      <div className="insight-evidence">
        {insight.evidence.map((item) => (
          <span className="insight-chip" key={item.label}>
            <em>{item.label}</em>
            <b className="mono">{item.value}</b>
          </span>
        ))}
      </div>
      <div className="insight-action"><strong>Do this:</strong> {insight.action}</div>
      <div className="insight-foot">
        {insight.moneyAtRisk === null
          ? "No monetary basis for this signal"
          : `${fmtMoney(insight.moneyAtRisk, insight.currency)} — ${insight.moneyBasis}`}
        {" · "}confidence {insight.confidence}
        {insight.freshness ? ` · ${insight.freshness}` : ""}
        {insight.mergedCount > 1 ? ` · ${insight.mergedCount} similar alerts merged` : ""}
      </div>
    </div>
  );
}

/**
 * Priority Actions — the compact, financially ranked "fix this first" area every
 * report carries. Risks come before opportunities and within a severity band the
 * largest money at risk leads. When an account reports more than one currency,
 * the ordering says so instead of comparing incomparable numbers.
 */
export function PriorityActions({ insights, limit = 8, mixedCurrency = false, onExport, exportDisabled, title = "Priority Actions", emptyNote }) {
  const shown = insights.slice(0, limit);
  return (
    <div className="panel priority-panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">{title}</div>
          <div className="page-sub">
            {insights.length
              ? `${insights.length} evidence-backed signal${insights.length === 1 ? "" : "s"}, ranked by financial impact and urgency`
              : "Nothing met the evidence thresholds in this scope"}
            {mixedCurrency ? " · this account reports more than one currency, so signals are ranked by severity and confidence within each currency rather than by a combined total" : ""}
          </div>
        </div>
        {onExport && <ExportButton onClick={onExport} disabled={exportDisabled} label="Download insights" />}
      </div>
      {shown.length === 0
        ? <div className="empty-note">{emptyNote || "No action needed from this report right now."}</div>
        : <div className="insight-list">{shown.map((insight) => <InsightRow insight={insight} key={insight.id} />)}</div>}
      {insights.length > shown.length && (
        <div className="page-sub" style={{ marginTop: 10 }}>
          Showing the top {shown.length} of {insights.length}. The full set is included in the insight export.
        </div>
      )}
    </div>
  );
}

/** Local sort-key toggle shared by the new tables. */
export function useSortState(initialKey, textColumns = []) {
  const [sort, setSort] = React.useState({ key: initialKey, dir: "desc" });
  const onSort = React.useCallback((key) => {
    setSort((previous) => previous.key === key
      ? { key, dir: previous.dir === "asc" ? "desc" : "asc" }
      : { key, dir: textColumns.includes(key) ? "asc" : "desc" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [sort, onSort];
}

/**
 * Compare two rows on a sort key. Nulls always sort last regardless of
 * direction, so "unknown" never masquerades as the smallest value.
 */
export function compareRows(a, b, accessor, dir) {
  const av = accessor(a);
  const bv = accessor(b);
  const aNull = av === null || av === undefined || Number.isNaN(av);
  const bNull = bv === null || bv === undefined || Number.isNaN(bv);
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  const cmp = typeof av === "string" || typeof bv === "string"
    ? String(av).localeCompare(String(bv))
    : av - bv;
  return dir === "asc" ? cmp : -cmp;
}

export function sortRows(rows, accessors, sort, fallbackKey) {
  const accessor = accessors[sort.key] || accessors[fallbackKey];
  return [...rows].sort((a, b) => compareRows(a, b, accessor, sort.dir));
}

/** Simple pager matching the existing reconciliation pagination. */
export function Pagination({ page, pageCount, onChange }) {
  if (pageCount <= 1) return null;
  const pages = [...new Set([1, pageCount, page - 1, page, page + 1])]
    .filter((value) => value >= 1 && value <= pageCount)
    .sort((a, b) => a - b);
  return (
    <div className="recon-pagination">
      <button disabled={page === 1} onClick={() => onChange(Math.max(1, page - 1))}>Prev</button>
      {pages.map((value, index) => (
        <React.Fragment key={value}>
          {index > 0 && value - pages[index - 1] > 1 && <span>…</span>}
          <button className={value === page ? "active" : ""} onClick={() => onChange(value)}>{value}</button>
        </React.Fragment>
      ))}
      <button disabled={page === pageCount} onClick={() => onChange(Math.min(pageCount, page + 1))}>Next</button>
    </div>
  );
}
