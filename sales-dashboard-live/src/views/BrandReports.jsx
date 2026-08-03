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

import { DataQualityAlert, MetricCard } from "../components/ui.jsx";
import { fmtDateHuman, fmtRangeLabel, nInt } from "../lib/format.js";
import { isConvertedMode } from "../lib/brand-view.js";
import { DASH, buildBrandTables } from "../lib/brand-view-tables.js";

/* ------------------------------------------------------------------ table */

export function ReportPanel({ title, subtitle, headers, rows, minWidth }) {
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
                  className={index === 0 ? "bv-first" : "bv-num"}
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
              if (row.kind === "section") {
                return (
                  <tr className="bv-section" key={row.key}>
                    <td colSpan={headers.length}>{row.cells[0].t}</td>
                  </tr>
                );
              }
              return (
                <tr className={row.kind === "total" ? "bv-total" : undefined} key={row.key}>
                  {row.cells.map((value, index) => (
                    <td
                      key={index}
                      className={index === 0 ? "bv-first" : "bv-num"}
                      title={row.hints?.[index] || undefined}
                    >
                      {index === 0 ? row.label || value.t : value.t}
                      {index === 0 && row.sublabel ? <small>{row.sublabel}</small> : null}
                      {index > 0 && row.subcells?.[index] ? <small>{row.subcells[index]}</small> : null}
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
    coverage.adsFrom ? `ads coverage ${coverage.adsFrom} to ${coverage.adsTo}` : "ads coverage unavailable",
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
  const rangeLabel = rangeFrom && rangeTo ? fmtRangeLabel(rangeFrom, rangeTo) : "";
  const lastYear = tables.daily?.lastYearWindow;

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

      <div className="metric-grid bv-kpis">
        <MetricCard label="Brand" value={model.brand} period={scopeLabel} />
        <MetricCard
          label="Marketplaces"
          value={nInt(tables.marketplaceCount)}
          period={rangeLabel}
          hint="Only marketplaces where this brand has sales or FBA inventory in the selected scope."
        />
        <MetricCard label="Units sold" value={nInt(tables.totalUnits)} period="never currency converted" />
        <MetricCard
          label="Currency mode"
          value={converted ? displayCurrency : "Original"}
          period={converted ? "totals are sums of converted rows" : "grouped per currency, never combined"}
          hint={converted
            ? "Every country value is converted individually at full precision; the totals are the sums of those converted values."
            : "Money stays in each marketplace's own currency. There is deliberately no single cross-currency total."}
        />
      </div>

      {tables.dailyTable && (
        <ReportPanel
          title={`Daily Snapshot — ${model.brand}`}
          subtitle={`${rangeLabel} · ${currencyLabel}${lastYear ? ` · last year compares ${fmtRangeLabel(lastYear.from, lastYear.to)}` : " · last year unavailable for this window"}`}
          headers={tables.dailyTable.headers}
          rows={tables.dailyTable.rows}
          minWidth={880}
        />
      )}
      {tables.monthlyTable && (
        <ReportPanel
          title={`Monthly Snapshot — ${model.brand}`}
          subtitle={`Five completed calendar months, the selected month to date and its run rate · ${currencyLabel} · share of the group total shown under each value`}
          headers={tables.monthlyTable.headers}
          rows={tables.monthlyTable.rows}
          minWidth={1020}
        />
      )}
      {tables.weeklyTable && (
        <ReportPanel
          title={`7-Day Performance — ${model.brand}`}
          subtitle={`Seven days ending ${tables.anchor ? fmtDateHuman(tables.anchor) : ""} · ${currencyLabel} · units are never converted`}
          headers={tables.weeklyTable.headers}
          rows={tables.weeklyTable.rows}
          minWidth={980}
        />
      )}
    </>
  );
}
