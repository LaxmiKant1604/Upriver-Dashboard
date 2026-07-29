// Sales Movers — week-over-week ASIN gains and declines, with the sales change
// decomposed exactly into traffic, conversion and price effects.

import React, { useMemo, useState } from "react";
import { TrendingUp } from "lucide-react";

import {
  buildSalesMoversInsights,
  buildSalesMoversRows,
  insightExportRows,
  salesMoversCompletenessWarning,
} from "../lib/insights.js";
import { downloadCsv, reportFilename } from "../lib/csv.js";
import { fmtDateHuman, fmtMoney, fmtPct, fmtPoints, fmtRate, nInt } from "../lib/format.js";
import {
  ExportButton,
  FreshnessBar,
  Notice,
  PriorityActions,
  ReportHeader,
  SearchField,
  SelectField,
  SnapshotState,
  SortTh,
  StatRow,
  IdentityCell,
  snapshotFreshnessLabel,
  sortRows,
  useSortState,
} from "./shared.jsx";

const DIRECTION_OPTIONS = [
  { value: "ALL", label: "Gainers and decliners" },
  { value: "decline", label: "Decliners only" },
  { value: "gain", label: "Gainers only" },
];

const DRIVER_OPTIONS = [
  { value: "ALL", label: "All drivers" },
  { value: "traffic", label: "Traffic" },
  { value: "conversion", label: "Conversion" },
  { value: "price", label: "Price / mix" },
  { value: "unattributed", label: "Not attributable" },
];

const DRIVER_LABEL = {
  traffic: "Traffic",
  conversion: "Conversion",
  price: "Price / mix",
};

const ACCESSORS = {
  productName: (row) => String(row.productName || row.asin || "").toLowerCase(),
  brand: (row) => String(row.brand || "").toLowerCase(),
  recentSales: (row) => Number(row.recent?.sales) || 0,
  priorSales: (row) => Number(row.prior?.sales) || 0,
  salesDelta: (row) => row.salesDelta,
  absSalesDelta: (row) => Math.abs(row.salesDelta),
  salesDeltaPct: (row) => row.salesDeltaPct,
  sessions: (row) => Number(row.recent?.sessions) || 0,
  sessionsDeltaPct: (row) => row.sessionsDeltaPct,
  cvrRecent: (row) => row.cvrRecent,
  cvrDeltaPoints: (row) => row.cvrDeltaPoints,
  aspRecent: (row) => row.aspRecent,
  aspDeltaPct: (row) => row.aspDeltaPct,
  units: (row) => Number(row.recent?.units) || 0,
  adSpendDelta: (row) => row.adSpendDelta,
  available: (row) => (row.inventory ? row.inventory.available : null),
  driver: (row) => row.dominantDriver || "zzz",
};

export default function SalesMovers({ data, loading, error, accountName, selectedBrand, currency, onRefresh }) {
  const [search, setSearch] = useState("");
  const [direction, setDirection] = useState("ALL");
  const [driver, setDriver] = useState("ALL");
  const [sort, onSort] = useSortState("absSalesDelta", ["productName", "brand", "driver"]);

  const rows = useMemo(() => buildSalesMoversRows(data, selectedBrand), [data, selectedBrand]);
  const insights = useMemo(() => buildSalesMoversInsights(data, rows, currency), [data, rows, currency]);
  const completeness = useMemo(() => salesMoversCompletenessWarning(rows), [rows]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (direction !== "ALL" && row.direction !== direction) return false;
      if (driver !== "ALL") {
        if (driver === "unattributed" ? row.dominantDriver !== null : row.dominantDriver !== driver) return false;
      }
      if (!query) return true;
      return `${row.asin || ""} ${row.productName || ""} ${row.brand || ""}`.toLowerCase().includes(query);
    });
  }, [rows, search, direction, driver]);

  const sorted = useMemo(() => sortRows(filtered, ACCESSORS, sort, "absSalesDelta"), [filtered, sort]);

  const totals = useMemo(() => {
    const gains = rows.filter((row) => row.direction === "gain");
    const declines = rows.filter((row) => row.direction === "decline");
    return {
      recentSales: rows.reduce((sum, row) => sum + (Number(row.recent?.sales) || 0), 0),
      priorSales: rows.reduce((sum, row) => sum + (Number(row.prior?.sales) || 0), 0),
      gainValue: gains.reduce((sum, row) => sum + row.salesDelta, 0),
      declineValue: declines.reduce((sum, row) => sum + row.salesDelta, 0),
      gainCount: gains.length,
      declineCount: declines.length,
    };
  }, [rows]);

  const state = <SnapshotState data={data} loading={loading} error={error} label="Sales Movers report" icon={<TrendingUp size={22} />} />;
  const scopeLabel = `${accountName || "the selected account"}${selectedBrand === "ALL" ? "" : ` · ${selectedBrand}`}`;

  const exportTable = () => downloadCsv(sorted.map((row) => ({
    "Product Name": row.productName || "",
    ASIN: row.asin || "",
    Brand: row.brand || "",
    Currency: currency || "",
    "Sales (recent 7d)": Number(row.recent?.sales || 0).toFixed(2),
    "Sales (prior 7d)": Number(row.prior?.sales || 0).toFixed(2),
    "Sales Change": Number(row.salesDelta || 0).toFixed(2),
    "Sales Change %": row.salesDeltaPct === null ? "" : row.salesDeltaPct.toFixed(1),
    "Units (recent 7d)": Math.round(Number(row.recent?.units) || 0),
    "Units (prior 7d)": Math.round(Number(row.prior?.units) || 0),
    "Sessions (recent 7d)": Math.round(Number(row.recent?.sessions) || 0),
    "Sessions (prior 7d)": Math.round(Number(row.prior?.sessions) || 0),
    "Sessions Change %": row.sessionsDeltaPct === null ? "" : row.sessionsDeltaPct.toFixed(1),
    "Units per Session (recent)": row.cvrRecent === null ? "" : (row.cvrRecent * 100).toFixed(2),
    "Units per Session Change pp": row.cvrDeltaPoints === null ? "" : row.cvrDeltaPoints.toFixed(2),
    "Avg Selling Price (recent)": row.aspRecent === null ? "" : row.aspRecent.toFixed(2),
    "Avg Selling Price Change %": row.aspDeltaPct === null ? "" : row.aspDeltaPct.toFixed(1),
    "Traffic Effect": row.contributions ? row.contributions.traffic.toFixed(2) : "",
    "Conversion Effect": row.contributions ? row.contributions.conversion.toFixed(2) : "",
    "Price Effect": row.contributions ? row.contributions.price.toFixed(2) : "",
    "Dominant Driver": row.dominantDriver ? DRIVER_LABEL[row.dominantDriver] : "Not attributable",
    "Ad Spend Change": Number(row.adSpendDelta || 0).toFixed(2),
    "Ad Sales Change": Number(row.adSalesDelta || 0).toFixed(2),
    "FBA Available": row.inventory ? Math.round(row.inventory.available) : "",
    "Days of Supply": row.inventory && row.inventory.daysOfSupply !== null ? Math.round(row.inventory.daysOfSupply) : "",
  })), reportFilename("sales-movers", accountName, data?.salesLatestDate));

  const exportInsights = () => downloadCsv(insightExportRows(insights), reportFilename("sales-movers-insights", accountName, data?.salesLatestDate));

  return (
    <div className="container skupl-page">
      <ReportHeader
        title="Sales Movers"
        subtitle={`Week-over-week ASIN gains and declines for ${scopeLabel}, decomposed into traffic, conversion and price`}
      />

      {state}

      {data && !data.snapshotMissing && data.dataUnavailable && (
        <Notice tone="warn">{data.unavailableReason}</Notice>
      )}

      {data && !data.snapshotMissing && !data.dataUnavailable && <>
        <FreshnessBar items={[
          `${data.sourceLabel} through ${fmtDateHuman(data.salesLatestDate)}`,
          `this week ${fmtDateHuman(data.windows.recent.from)} – ${fmtDateHuman(data.windows.recent.to)} vs prior week ${fmtDateHuman(data.windows.prior.from)} – ${fmtDateHuman(data.windows.prior.to)}`,
          `source can lag up to about ${data.lagDays} days, so both windows end on the latest completed date`,
          data.inventoryAvailable ? `FBA snapshot ${fmtDateHuman(data.inventorySnapshotDate)}` : "FBA snapshot unavailable",
          snapshotFreshnessLabel(data),
        ]} />

        {completeness && <Notice tone="warn">{completeness}</Notice>}

        {!data.inventoryAvailable && (
          <Notice tone="warn">
            Live FBA inventory is unavailable for this account, so stockout signals are not evaluated. Sales, traffic and conversion movements are unaffected.
          </Notice>
        )}

        {(data.currencies?.length || 0) > 1 && (
          <Notice>
            This account reported {data.currencies.length} currencies ({data.currencies.join(", ")}) in the advertising source. Money values are shown in {currency} and are never combined across currencies.
          </Notice>
        )}

        <StatRow stats={[
          { label: "Sales this week", value: fmtMoney(totals.recentSales, currency) },
          { label: "Sales prior week", value: fmtMoney(totals.priorSales, currency) },
          { label: `Decliners (${totals.declineCount})`, value: fmtMoney(totals.declineValue, currency), tone: "bad" },
          { label: `Gainers (${totals.gainCount})`, value: fmtMoney(totals.gainValue, currency), tone: "good" },
          { label: "ASINs in scope", value: nInt(rows.length) },
        ]} />

        <PriorityActions
          insights={insights}
          mixedCurrency={(data.currencies?.length || 0) > 1}
          onExport={exportInsights}
          exportDisabled={!insights.length}
          emptyNote="No ASIN moved enough week over week to justify an action in this scope."
        />

        <div className="panel skupl-table-panel" style={{ padding: 0, overflow: "hidden" }}>
          <div className="skupl-toolbar">
            <SearchField value={search} onChange={setSearch} placeholder="ASIN, product, or brand" />
            <SelectField label="Direction" value={direction} onChange={setDirection} options={DIRECTION_OPTIONS} />
            <SelectField label="Driver" value={driver} onChange={setDriver} options={DRIVER_OPTIONS} />
            <div className="skupl-toolbar-spacer" />
            <ExportButton onClick={exportTable} disabled={!sorted.length} />
          </div>
          <div className="plan-scroll">
            <table className="plan-table movers-table">
              <thead>
                <tr>
                  <SortTh className="pt-id" label="Product / ASIN" col="productName" sort={sort} onSort={onSort} align="left" />
                  <SortTh label="Sales (7d)" col="recentSales" sort={sort} onSort={onSort} />
                  <SortTh label="Sales (prior 7d)" col="priorSales" sort={sort} onSort={onSort} />
                  <SortTh label="Change" col="salesDelta" sort={sort} onSort={onSort} />
                  <SortTh label="Change %" col="salesDeltaPct" sort={sort} onSort={onSort} />
                  <SortTh label="Sessions" col="sessions" sort={sort} onSort={onSort} />
                  <SortTh label="Sessions Δ%" col="sessionsDeltaPct" sort={sort} onSort={onSort} />
                  <SortTh label="Units / Session" col="cvrRecent" sort={sort} onSort={onSort} hint="Units divided by sessions, recomputed from the summed totals" />
                  <SortTh label="Conv. Δpp" col="cvrDeltaPoints" sort={sort} onSort={onSort} />
                  <SortTh label="Avg Price" col="aspRecent" sort={sort} onSort={onSort} hint="Sales divided by units" />
                  <SortTh label="Price Δ%" col="aspDeltaPct" sort={sort} onSort={onSort} />
                  <SortTh label="Ad Spend Δ" col="adSpendDelta" sort={sort} onSort={onSort} />
                  <SortTh label="FBA Avail" col="available" sort={sort} onSort={onSort} />
                  <SortTh label="Dominant Driver" col="driver" sort={sort} onSort={onSort} align="left" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((row) => (
                  <tr key={row.asin} className={row.direction === "decline" && row.salesDeltaPct !== null && row.salesDeltaPct <= -25 ? "plan-restock" : ""}>
                    <IdentityCell name={row.productName} primary={row.asin} brand={row.brand} />
                    <td className="mono">{fmtMoney(row.recent.sales, currency)}</td>
                    <td className="mono">{fmtMoney(row.prior.sales, currency)}</td>
                    <td className={"mono pt-strong" + (row.salesDelta < 0 ? " sku-neg" : row.salesDelta > 0 ? " sku-pos" : "")}>{fmtMoney(row.salesDelta, currency)}</td>
                    <td className={"mono" + (row.salesDeltaPct !== null && row.salesDeltaPct < 0 ? " sku-neg" : row.salesDeltaPct !== null && row.salesDeltaPct > 0 ? " sku-pos" : "")}>{fmtPct(row.salesDeltaPct)}</td>
                    <td className="mono">{nInt(row.recent.sessions)}</td>
                    <td className="mono">{fmtPct(row.sessionsDeltaPct)}</td>
                    <td className="mono">{row.cvrRecent === null ? "—" : fmtRate(row.cvrRecent * 100, 2)}</td>
                    <td className="mono">{fmtPoints(row.cvrDeltaPoints, 2)}</td>
                    <td className="mono">{row.aspRecent === null ? "—" : fmtMoney(row.aspRecent, currency, 2)}</td>
                    <td className="mono">{fmtPct(row.aspDeltaPct)}</td>
                    <td className="mono">{fmtMoney(row.adSpendDelta, currency)}</td>
                    <td className="mono">{row.inventory ? nInt(row.inventory.available) : "—"}</td>
                    <td className="movers-driver">
                      {row.dominantDriver
                        ? <span className={"pt-badge driver-" + row.dominantDriver}>{DRIVER_LABEL[row.dominantDriver]}</span>
                        : <span className="movers-unattributed" title="This ASIN had no sessions or no units in one of the two weeks, so the change cannot be attributed to traffic, conversion or price.">Not attributable</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!sorted.length && <div className="empty-note" style={{ padding: "14px 16px" }}>{rows.length ? "No ASINs match these filters." : "No ASINs reported sessions or sales in either week for this scope."}</div>}
        </div>

        <div className="footer-note">
          Sales, units, sessions and page views come from DataDoe <code>Sales &amp; Traffic by ASIN &amp; Date</code>, summed per ASIN over two equal seven-day windows. That source's documented recurring window is {data.lagDays} days, so both windows end at the latest date the source actually reported units ({fmtDateHuman(data.salesLatestDate)}) rather than at today — this is why the report is not a calendar week. Advertising change comes from <code>Profit by SKU &amp; Date</code> (<code>ad_spend</code>, <code>ad_sales</code>) grouped to ASIN; stock comes from the latest <code>FBA Inventory Health</code> snapshot.
          {" "}Because sales = sessions × (units ÷ sessions) × (sales ÷ units), the change is split exactly into a traffic effect, a conversion effect and a price effect that sum to the total change; the dominant driver is simply the largest of the three. An ASIN with no sessions or no units in one of the weeks shows <strong>Not attributable</strong> instead of a guessed driver. Units per session and average price are recomputed from the summed totals — no percentage is ever averaged. Buy Box share is <strong>not</strong> evaluated here because aggregating it correctly needs a page-view-weighted average of daily rows; the Buy Box Loss report does that on its own scope. Changing account, brand, filters, search or sorting re-derives everything locally; only Refresh calls DataDoe, and it saves one shared snapshot for every user with access to this account.
        </div>
      </>}
    </div>
  );
}
