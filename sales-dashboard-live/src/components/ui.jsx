/* =====================================================================
   UPRIVER shared UI primitives
   =====================================================================

   The reusable pieces every current and future report is expected to build
   from. They carry no data logic of their own: each one takes already-computed,
   already-formatted values so a report's calculations stay in the report.

   Rules these components enforce for you:
   - An unknown value is an em dash, never a zero. Pass `null` and the card
     shows "—" instead of inventing a measurement.
   - Direction is never communicated by colour alone: every trend and
     comparison carries an arrow icon and an explicit + / − sign.
   - Money always takes an explicit currency from the caller. Nothing here
     converts or combines currencies.

   Styling comes entirely from src/styles/theme.js. Do not add inline colours,
   spacing or radii here or in a report — extend the tokens instead.        */

import React from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Info,
  Minus,
  RefreshCw,
} from "lucide-react";

/* ---------------------------------------------------------------- helpers */

/** "up" | "down" | "flat" for a signed change; "flat" also covers unknown. */
export function direction(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "flat";
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "flat";
}

/* ------------------------------------------------------------ indicators */

/**
 * TrendIndicator — a compact signed change pill.
 *
 * `text` is the already-formatted change (e.g. "+12.4%"), so the caller keeps
 * control of precision and of what "change" means for that metric.
 */
export function TrendIndicator({ value, text, title, iconSize = 13 }) {
  const dir = direction(value);
  const Icon = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : Minus;
  return (
    <span className={"trend " + dir} title={title || undefined}>
      <Icon size={iconSize} aria-hidden="true" />
      {text}
    </span>
  );
}

/**
 * MetricTooltip — the small "what is this" affordance next to a metric label.
 * Uses the native tooltip plus an accessible label so it works with a keyboard
 * and a screen reader without shipping a popover library.
 */
export function MetricTooltip({ text }) {
  if (!text) return null;
  return (
    <span className="metric-hint" tabIndex={0} role="note" aria-label={text} title={text}>
      <Info size={13} aria-hidden="true" />
    </span>
  );
}

export function StatusBadge({ tone = "neutral", children, title }) {
  return <span className={"status-badge " + tone} title={title || undefined}>{children}</span>;
}

/* -------------------------------------------------------------- sparkline */

/**
 * Sparkline — a tiny inline chart drawn from real history only.
 *
 * Renders nothing at all when fewer than three real points exist, because a
 * one- or two-point "trend" is decoration, not information.
 */
export function Sparkline({ values, color = "#8B5CF6", height = 26, ariaLabel }) {
  const points = (values || []).filter((v) => Number.isFinite(v));
  if (points.length < 3) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = 100 / (points.length - 1);
  const coords = points.map((value, index) => {
    const x = index * step;
    const y = 26 - ((value - min) / span) * 24 - 1;
    return [x, y];
  });
  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `${line} L100,26 L0,26 Z`;
  const [lastX, lastY] = coords[coords.length - 1];
  return (
    <div className="metric-spark" style={{ height }}>
      <svg viewBox="0 0 100 26" preserveAspectRatio="none" role="img" aria-label={ariaLabel || "Trend sparkline"} focusable="false">
        <path d={area} fill={color} fillOpacity="0.10" stroke="none" />
        <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <circle cx={lastX} cy={lastY} r="1.9" fill={color} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------ metric card */

/**
 * MetricCard — the primary KPI surface (depth level 2).
 *
 * `value` is pre-formatted. `trend` and `spark` are optional and should be
 * omitted entirely when the underlying comparison or history does not exist,
 * rather than passed as zero.
 */
export function MetricCard({ label, value, hint, period, trend, spark, tone, variant, icon }) {
  return (
    <div className={"metric-card" + (variant ? ` ${variant}` : "")}>
      <div className="metric-top">
        <div className="metric-label">{label}</div>
        <span className="metric-actions">
          {icon ? <span className="metric-icon" aria-hidden="true">{icon}</span> : null}
          <MetricTooltip text={hint} />
        </span>
      </div>
      <div className={"metric-value" + (tone === "bad" ? " sku-neg" : tone === "good" ? " sku-pos" : "")}>{value}</div>
      <div className="metric-foot">
        {trend}
        {period && <span className="metric-period">{period}</span>}
      </div>
      {spark}
    </div>
  );
}

/**
 * ComparisonMetric — one cell of the performance-comparison row.
 *
 * `data` is the existing dashboard comparison shape:
 *   { value: number|null, insufficient: boolean, curr: number|null }
 * so period-over-period logic stays where it already lives and is not
 * duplicated here.
 */
export function ComparisonMetric({ label, basis, data, format }) {
  if (!data) {
    return (
      <div className="cmp-card">
        <div className="cmp-label">{label}</div>
        <div className="cmp-value flat"><Minus size={15} aria-hidden="true" /> —</div>
        <div className="cmp-basis">Awaiting data</div>
      </div>
    );
  }
  if (data.insufficient) {
    return (
      <div className="cmp-card">
        <div className="cmp-label">{label}</div>
        <div className="cmp-value flat"><Info size={15} aria-hidden="true" /> —</div>
        <div className="cmp-basis">Not enough history yet</div>
      </div>
    );
  }
  const value = data.value;
  // A comparison against a zero base is "New", not an infinite percentage.
  const text = value === null ? (data.curr > 0 ? "New" : "—") : format(value);
  const dir = direction(value);
  const Icon = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : Minus;
  return (
    <div className="cmp-card">
      <div className="cmp-label">{label}</div>
      <div className={"cmp-value " + dir}>
        <Icon size={15} aria-hidden="true" />
        {text}
      </div>
      <div className="cmp-basis">{basis}</div>
    </div>
  );
}

/* ------------------------------------------------------------- chart card */

export function ChartCard({ title, subtitle, actions, children, bodyClass = "" }) {
  return (
    <section className="chart-card">
      <div className="chart-card-head">
        <div>
          <div className="chart-card-title">{title}</div>
          {subtitle && <div className="chart-card-sub">{subtitle}</div>}
        </div>
        {actions}
      </div>
      <div className={"chart-card-body " + bodyClass}>{children}</div>
    </section>
  );
}

/**
 * ChartTooltip — recharts tooltip content.
 *
 * `rows` maps a recharts payload entry to `{ key, label, value, color }` and
 * MUST return null for anything the payload does not actually contain, so a
 * tooltip never shows a metric the source did not supply.
 */
export function ChartTooltip({ active, payload, label, rows }) {
  if (!active || !payload || !payload.length) return null;
  const entries = (rows ? rows(payload[0]?.payload, payload) : []).filter(Boolean);
  if (!entries.length) return null;
  return (
    <div className="chart-tip">
      <div className="chart-tip-label">{label}</div>
      <div className="chart-tip-rows">
        {entries.map((row) => (
          <div className="chart-tip-row" key={row.key}>
            <span className="chart-tip-key">
              {row.color && <span className="chart-tip-swatch" style={{ background: row.color }} />}
              {row.label}
            </span>
            <b>{row.value}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- breakdown card */

export function ContributionBar({ ratio, active, muted, color }) {
  const width = Math.max(0, Math.min(100, (Number(ratio) || 0) * 100));
  return (
    <div className="bd-bar" role="presentation">
      <div
        className={"bd-fill" + (active ? " active" : "") + (muted ? " muted" : "")}
        style={{ width: width + "%", ...(color && !muted ? { background: color, boxShadow: `0 0 10px ${color}55` } : {}) }}
      />
    </div>
  );
}

/**
 * BreakdownCard — the "Sales by X" pattern.
 *
 * `items` are `{ key, label, flag, value, share }` exactly as the dashboard
 * already computes them. `formatValue` receives the raw value so the caller
 * controls currency; nothing here assumes a currency.
 */
export function BreakdownCard({ title, subtitle, items, activeKeys, formatValue, mutedKeys, emptyMessage, footer, palette }) {
  const max = items.reduce((top, item) => Math.max(top, Math.abs(item.value)), 0);
  const active = activeKeys || new Set();
  const muted = mutedKeys || new Set(["Unassigned"]);
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">{title}</div>
          {subtitle && <div className="page-sub">{subtitle}</div>}
        </div>
      </div>
      {items.length === 0 ? (
        <div className="empty-note">{emptyMessage || "No data for this period."}</div>
      ) : (
        <div className="bd-list">
          {items.map((item, index) => {
            const isActive = active.has(item.key);
            const isMuted = muted.has(item.key);
            return (
              <div
                className={"bd-row" + (isActive ? " active" : "") + (isMuted ? " muted" : "")}
                key={item.key}
                title={`${item.label} · ${item.share.toFixed(1)}% of the selected range`}
              >
                <div className="bd-main">
                  <div className="bd-name">
                    {item.flag ? <span aria-hidden="true">{item.flag}</span> : null}
                    <span>{item.label}</span>
                  </div>
                  <ContributionBar
                    ratio={max ? Math.abs(item.value) / max : 0}
                    active={isActive}
                    muted={isMuted}
                    color={palette?.length ? palette[index % palette.length] : undefined}
                  />
                </div>
                <div className="bd-figures">
                  <div className="bd-value">{formatValue(item.value)}</div>
                  <div className="bd-share">{item.share.toFixed(1)}%</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {footer}
    </section>
  );
}

/* ------------------------------------------------------------- alert bar */

/**
 * DataQualityAlert — a compact contextual alert for real data-availability
 * problems. It never replaces the KPIs; it sits above them and stays quiet.
 */
export function DataQualityAlert({ tone = "warning", title, detail, icon }) {
  const Icon = icon || (tone === "info" ? Info : AlertTriangle);
  return (
    <div className={"alert " + tone} role={tone === "error" ? "alert" : "status"}>
      <Icon size={15} className="alert-icon" aria-hidden="true" />
      <div className="alert-body">
        <div className="alert-title">{title}</div>
        {detail && <div className="alert-detail">{detail}</div>}
      </div>
    </div>
  );
}

/* -------------------------------------------------- observed-unit breakdown */

/**
 * ObservedUnitsBreakdown -- a compact, transparent breakdown of the day's OBSERVED units by class, shown beside the
 * completeness/provisional line. Revenue is deliberately excluded from explicit-zero + pending units; identifiable
 * pending units DO move unit reporting; SKU-less pending units cannot be assigned to a product yet. It renders
 * nothing when there is no `completeness.unitBreakdown` (advisory -- degrades gracefully pre-backfill). Never a red
 * failure banner: expected pending itemization is a neutral, informational note.
 */
export function ObservedUnitsBreakdown({ completeness }) {
  const b = completeness && completeness.unitBreakdown;
  if (!b) return null;
  const nf = (v) => (Number(v) || 0).toLocaleString();
  const chips = [
    { key: "priced", cls: "priced", label: "Priced", value: b.pricedUnits },
    { key: "zero", cls: "zero", label: "Explicit zero-price", value: b.explicitZeroUnits },
    { key: "pend-sku", cls: "pending", label: "Pending · has SKU", value: b.pendingWithSkuUnits },
    { key: "pend-nosku", cls: "pending", label: "Pending · no SKU", value: b.pendingWithoutSkuUnits },
    { key: "cancelled", cls: "cancelled", label: "Cancelled", value: b.cancelledUnits },
  ];
  const status = completeness.provisional ? "Provisional" : (completeness.sourceDefect ? "Source issue" : "Final");
  return (
    <div className="obs-units" role="status" aria-label="Observed unit breakdown">
      <div className="obs-units-head">
        <span className="obs-units-title">Observed units{b.onDate ? ` — ${b.onDate}` : ""}</span>
        <span className="obs-units-total">{nf(b.observedUnits)} total · {nf(b.skuMovementUnits)} in SKU Movement · {status}</span>
      </div>
      <div className="obs-units-chips">
        {chips.map((c) => (
          <span key={c.key} className={"obs-chip obs-chip-" + c.cls}>
            <span className="obs-chip-v">{nf(c.value)}</span> {c.label}
          </span>
        ))}
      </div>
      <div className="obs-units-note">
        Revenue counts priced units only — explicit zero-price and pending-price units add no sales. Explicit-zero and
        SKU-identifiable pending units are included in unit movement; unallocated pending units (no SKU/ASIN yet) are not.
        {completeness.finalizedThrough ? ` Fully finalized through ${completeness.finalizedThrough}.` : ""} Values reconcile automatically on later order refreshes.
      </div>
    </div>
  );
}

/* -------------------------------------------------- loading / empty / error */

export function SkeletonLine({ width = "100%", height = 11, style }) {
  return <div className="skeleton sk-line" style={{ width, height, ...style }} />;
}

/** Skeleton geometry deliberately mirrors MetricCard's real layout. */
export function SkeletonCard() {
  return (
    <div className="sk-card">
      <SkeletonLine width="42%" height={9} />
      <SkeletonLine width="66%" height={24} style={{ marginTop: 12, borderRadius: 7 }} />
      <SkeletonLine width="34%" height={9} style={{ marginTop: 13 }} />
    </div>
  );
}

export function SkeletonMetricGrid({ count = 4 }) {
  return (
    <div className="metric-grid" aria-hidden="true">
      {Array.from({ length: count }, (unused, index) => <SkeletonCard key={index} />)}
    </div>
  );
}

/** Bars rather than a shimmering block, so the shape reads as a chart. */
export function SkeletonChart({ bars = 14 }) {
  const heights = [46, 62, 38, 74, 56, 88, 64, 42, 78, 58, 70, 48, 84, 60];
  return (
    <div className="sk-chart" aria-hidden="true">
      <SkeletonLine width="180px" height={10} />
      <div className="sk-bars">
        {Array.from({ length: bars }, (unused, index) => (
          <i className="skeleton" key={index} style={{ height: (heights[index % heights.length]) + "%" }} />
        ))}
      </div>
    </div>
  );
}

export function SkeletonTable({ rows = 6 }) {
  return (
    <div className="sk-rows" style={{ padding: "16px 18px" }} aria-hidden="true">
      {Array.from({ length: rows }, (unused, index) => (
        <div className="sk-row" key={index}>
          <SkeletonLine width="80%" />
          <SkeletonLine width="60%" />
          <SkeletonLine width="70%" />
          <SkeletonLine width="55%" />
          <SkeletonLine width="65%" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children, actions, tone = "" }) {
  return (
    <div className={"state-block " + tone}>
      {icon && <div className="state-icon">{icon}</div>}
      {title && <div className="state-title">{title}</div>}
      {children && <div className="state-body">{children}</div>}
      {actions && <div className="state-actions">{actions}</div>}
    </div>
  );
}

/**
 * ErrorState — shows the real upstream message. Errors are never softened into
 * a friendly placeholder, because the message is usually the fix.
 */
export function ErrorState({ title = "This report could not be loaded", message, onRetry, retryLabel = "Try again", busy }) {
  return (
    <div className="state-block error" role="alert">
      <div className="state-icon"><AlertTriangle size={19} aria-hidden="true" /></div>
      <div className="state-title">{title}</div>
      {message && <div className="state-body">{message}</div>}
      {onRetry && (
        <div className="state-actions">
          <button className="plan-export-btn" type="button" onClick={onRetry} disabled={busy}>
            <RefreshCw size={14} className={busy ? "spin" : ""} aria-hidden="true" />
            {retryLabel}
          </button>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- controls */

/**
 * SegmentedControl — the compact professional range/granularity switch.
 * Rendered as a real radio group so arrow keys and screen readers work.
 */
export function SegmentedControl({ options, value, onChange, ariaLabel, size = "" }) {
  return (
    <div className={"segmented " + size} role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={value === option.value ? "active" : ""}
          onClick={() => onChange(option.value)}
          title={option.hint || undefined}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
