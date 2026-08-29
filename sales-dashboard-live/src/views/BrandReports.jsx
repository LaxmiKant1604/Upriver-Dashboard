/* =====================================================================
   BRAND REPORTS — the three country-wise tables, shared by both Brand Views
   =====================================================================

   Rendered by:
     - src/views/BrandView.jsx       one account, one brand
     - src/views/BrandPortfolio.jsx  one brand across every account it sells in

   Both feed it the identical payload shape, so the two reports can never show
   different numbers for the same underlying data. All of the arithmetic lives in
   src/lib/brand-view.js and all of the table assembly in
   src/lib/brand-view-tables.js; this file is presentation only.               */

import React, { useMemo } from "react";
import { AlertTriangle, Info } from "lucide-react";

import { DataQualityAlert, GradientKpi, MoneyShare } from "../components/ui.jsx";
import { fmtRangeLabel, monthLongLabel, nInt } from "../lib/format.js";
import { isConvertedMode } from "../lib/brand-view.js";
import { DASH, buildBrandTables } from "../lib/brand-view-tables.js";

/* ------------------------------------------------------------------ table */

/**
 * One report table.
 *
 * A header may carry a `tone` (`positive`, `accent`, `latest`, `total`) which
 * tints its whole column, and a row may be a `band` (a currency divider, shown
 * only when the report has more than one currency) or a `section` (the "Units by
 * country" divider). Everything else is a plain row or the All Markets total.
 */
export function ReportPanel({ title, subtitle, headers, rows, minWidth }) {
  const columnClass = (index) => {
    if (index === 0) return "bv-first";
    const tone = headers[index]?.tone;
    return tone ? `bv-num bv-col-${tone}` : "bv-num";
  };

  return (
    <section className="panel bv-panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">{title}</div>
          {subtitle && <div className="page-sub">{subtitle}</div>}
        </div>
      </div>
      <div className="bv-scroll">
        <table className="bv-table" style={minWidth ? { minWidth } : undefined}>
          <thead>
            <tr>
              {headers.map((header, index) => (
                <th
                  key={header.key || index}
                  className={columnClass(index)}
                  scope="col"
                  title={header.hint || undefined}
                >
                  {header.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              if (row.kind === "section" || row.kind === "band") {
                return (
                  <tr className={row.kind === "band" ? "bv-band" : "bv-section"} key={row.key}>
                    <td colSpan={headers.length}>{row.cells[0].t}</td>
                  </tr>
                );
              }
              return (
                <tr className={row.kind === "total" ? "bv-total" : undefined} key={row.key}>
                  {row.cells.map((value, index) => (
                    <td
                      key={index}
                      className={columnClass(index)}
                      title={(index === 0 ? row.labelTitle : row.hints?.[index]) || undefined}
                    >
                      {index === 0
                        ? (row.label || value.t)
                        : (row.subcells?.[index]
                          // A money cell with a proven contribution share: the dedicated presenter keeps the amount
                          // and the percentage as two SEPARATE elements so they can never render as one mixed string.
                          ? <MoneyShare amount={value.t} share={row.subcells[index]} />
                          : value.t)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ freshness */

export function fxSummaryLine(fx, converted) {
  if (!converted) return "Not applicable — every marketplace is shown in its own currency.";
  if (!fx || fx.unavailable) return "Unavailable";
  const stamp = fx.providerUpdatedAt || fx.fetchedAt;
  return [
    `FX updated ${stamp ? new Date(stamp).toUTCString() : "unknown"}`,
    fx.fallback ? "cached fallback in use — the provider was unreachable" : null,
    fx.stale ? "older than one provider update cycle" : null,
    `base ${fx.base}`,
  ].filter(Boolean).join(" · ");
}

export function freshnessSummaryLine(model) {
  if (!model) return DASH;
  const coverage = model.coverage || {};
  return [
    coverage.accountCount > 1 ? `${coverage.accountCount} accounts` : null,
    coverage.salesSavedAt ? `oldest sales snapshot saved ${new Date(coverage.salesSavedAt).toLocaleString()}` : null,
    coverage.salesFrom && coverage.salesTo ? `sales coverage ${coverage.salesFrom} to ${coverage.salesTo}` : null,
    // Beyond this date not every account has reported, so the combined figure is
    // real but incomplete. Saying so is the difference between a slow account and
    // an apparent sales collapse.
    coverage.salesCompleteThrough && coverage.salesCompleteThrough !== coverage.salesLatestDate
      ? `all accounts complete through ${coverage.salesCompleteThrough}`
      : null,
    coverage.inventoryDate ? `FBA inventory as of ${coverage.inventoryDate}` : "FBA inventory unavailable",
  ].filter(Boolean).join(" · ");
}

/* -------------------------------------------------------------- exports */

/**
 * The neutral table model the exporters render. Built from exactly the same
 * tables the screen shows, so an export can never disagree with the page.
 */
export function buildExportModel({ tables, model, meta }) {
  if (!tables?.dailyTable || !tables.monthlyTable || !tables.weeklyTable) return null;
  const toReport = (id, title, subtitle, sheetName, table) => ({
    id,
    title,
    subtitle,
    sheetName,
    headers: table.headers.map((header) => header.label),
    rows: table.rows.map((row) => ({
      kind: row.kind,
      cells: row.cells.map((value, index) => {
        if (index !== 0) {
          const sub = row.subcells?.[index];
          return sub ? { ...value, t: `${value.t} (${sub})` } : value;
        }
        return { t: [row.label || value.t, row.sublabel].filter(Boolean).join(" — ") };
      }),
    })),
  });
  return {
    meta,
    reports: [
      toReport("daily", `Daily Snapshot — ${model.brand}`, `${meta.rangeLabel} · ${meta.currencyLabel}`, "Daily Snapshot", tables.dailyTable),
      toReport("monthly", `Monthly Snapshot — ${model.brand}`, `Five completed months plus the selected month and its run rate · ${meta.currencyLabel}`, "Monthly Snapshot", tables.monthlyTable),
      toReport("weekly", `7-Day Performance — ${model.brand}`, `Seven days ending ${tables.anchor || ""} · ${meta.currencyLabel}`, "7-Day Performance", tables.weeklyTable),
    ],
  };
}

/* ============================== THE REPORTS ============================== */

/**
 * @param {object} model            output of `brandViewModel`
 * @param {string} rangeFrom/rangeTo  the selected Daily Snapshot window
 * @param {string} displayCurrency  ORIGINAL_CURRENCY or an ISO code
 * @param {object} fx               the exchange-rate response, or null
 * @param {string} scopeLabel       what the KPI row calls this report's scope
 * @param {function} onTables       receives the built tables so the parent can
 *                                  drive its export menu from the same data
 */
export default function BrandReports({
  model, rangeFrom, rangeTo, displayCurrency, fx, fxError, scopeLabel, onTables,
}) {
  const rates = fx?.rates || null;
  const converted = isConvertedMode(displayCurrency);
  const currencyLabel = converted ? `Converted to ${displayCurrency}` : "Original marketplace currency";

  const tables = useMemo(
    () => buildBrandTables(model, { rangeFrom, rangeTo, displayCurrency, rates }),
    [displayCurrency, model, rangeFrom, rangeTo, rates]
  );

  // Hand the built tables back so the parent's Export menu renders exactly this.
  React.useEffect(() => { if (onTables) onTables(tables); }, [onTables, tables]);

  if (!tables) return null;
  const coverage = model.coverage || {};
  const rangeLabel = rangeFrom && rangeTo ? fmtRangeLabel(rangeFrom, rangeTo) : "";
  const lastYear = tables.daily?.lastYearWindow;
  const weekDates = tables.weekly?.dates || [];
  const weekLabel = weekDates.length ? fmtRangeLabel(weekDates[0], weekDates[weekDates.length - 1]) : "";
  // The subtitle states the run-rate formula with its real divisor, the way the
  // reference report does, so nobody has to guess how the projection was made.
  const monthly = tables.monthly?.columns?.current
    ? {
      completedLabel: tables.monthly.columns.completed.length
        ? `${monthLongLabel(tables.monthly.columns.completed[0].key)} – ${monthLongLabel(tables.monthly.columns.current.key)}`
        : monthLongLabel(tables.monthly.columns.current.key),
      currentLabel: monthLongLabel(tables.monthly.columns.current.key),
      elapsedDays: tables.monthly.columns.current.elapsedDays,
      daysInMonth: tables.monthly.columns.current.daysInMonth,
    }
    : null;

  return (
    <>
      {converted && fxError && (
        <DataQualityAlert tone="error" title="Currency conversion is unavailable" detail={fxError} icon={AlertTriangle} />
      )}
      {converted && fx?.fallback && (
        <DataQualityAlert
          tone="warning"
          title="Using cached exchange rates"
          detail={fx.message || "The exchange-rate provider was unreachable, so the last rates saved in Supabase are being used."}
        />
      )}
      {converted && !fxError && tables.missingRates.length > 0 && (
        <DataQualityAlert
          tone="warning"
          title={`No exchange rate for ${tables.missingRates.join(", ")}`}
          detail={`Those marketplaces cannot be converted to ${displayCurrency} and are shown as unavailable rather than with a substituted rate. Switch to Original marketplace currency to see their real figures.`}
        />
      )}
      {model.notes?.map((note) => (
        <DataQualityAlert key={note} tone="info" title="Partial source coverage" detail={note} icon={Info} />
      ))}

      <div className="rvkpi-grid rvkpi-grid-4 bv-kpis">
        <GradientKpi label="Brand" value={model.brand} sub={scopeLabel} gradient="linear-gradient(135deg,#FF6B6B,#FF8E53)" />
        <GradientKpi
          label="Marketplaces"
          value={nInt(tables.marketplaceCount)}
          sub={rangeLabel}
          hint="Only marketplaces where this brand has sales or FBA inventory in the selected scope."
          gradient="linear-gradient(135deg,#A78BFA,#7C3AED)"
        />
        <GradientKpi label="Units sold" value={nInt(tables.totalUnits)} sub="never currency converted" gradient="linear-gradient(135deg,#34D399,#059669)" />
        <GradientKpi
          label="Currency mode"
          value={converted ? displayCurrency : "Original"}
          sub={converted ? "totals are sums of converted rows" : "grouped per currency, never combined"}
          hint={converted
            ? "Every country value is converted individually at full precision; the totals are the sums of those converted values."
            : "Money stays in each marketplace's own currency. There is deliberately no single cross-currency total."}
          gradient="linear-gradient(135deg,#F59E0B,#D97706)"
        />
      </div>

      {tables.dailyTable && (
        <ReportPanel
          title={`${model.brand} — Daily Snapshot`}
          subtitle={[
            rangeLabel,
            lastYear ? `LY compares ${fmtRangeLabel(lastYear.from, lastYear.to)}` : "LY unavailable for this window",
            coverage.inventoryDate ? `FBA Inv. as of ${coverage.inventoryDate}` : "FBA Inv. unavailable",
            currencyLabel,
          ].filter(Boolean).join(" · ")}
          headers={tables.dailyTable.headers}
          rows={tables.dailyTable.rows}
          minWidth={900}
        />
      )}
      {tables.monthlyTable && (
        <ReportPanel
          title={`${model.brand} — Monthly Snapshot`}
          subtitle={[
            monthly ? `${monthly.completedLabel} · ${monthly.currentLabel} MTD (${monthly.elapsedDays} days)` : null,
            monthly ? `RR = (Act ÷ ${monthly.elapsedDays}) × ${monthly.daysInMonth}` : null,
            currencyLabel,
          ].filter(Boolean).join(" · ")}
          headers={tables.monthlyTable.headers}
          rows={tables.monthlyTable.rows}
          minWidth={1040}
        />
      )}
      {tables.weeklyTable && (
        <ReportPanel
          title={`${model.brand} — 7-Day Performance`}
          subtitle={[
            weekLabel,
            `${tables.marketplaceCount} marketplace${tables.marketplaceCount === 1 ? "" : "s"}`,
            currencyLabel,
          ].filter(Boolean).join(" · ")}
          headers={tables.weeklyTable.headers}
          rows={tables.weeklyTable.rows}
          minWidth={1000}
        />
      )}
    </>
  );
}
