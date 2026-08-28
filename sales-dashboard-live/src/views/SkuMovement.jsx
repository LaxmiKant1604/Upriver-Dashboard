// SKU Movement -- an advanced, per-ASIN/SKU units + trend + month-projection report, rendered ENTIRELY from the
// durable, zero-export sku-movement/v1 snapshot (the account's OLI daily rollup + Product Catalog). Every date and
// month label is dynamic (server-computed from the account's effectiveAsOf); nothing here is hard-coded. All the
// filtering/sorting/search/pagination/CSV is LOCAL, so it never refetches and never reaches DataDoe. "Reload latest
// data" is a read-only durable re-read (never an export). Brand scope is honoured exactly as the server derived it:
// a named-brand empty result is a VALID empty report (its own message), never an All-Brands fallback.

import React, { useMemo, useState, useEffect } from "react";
import { Activity, RefreshCw } from "lucide-react";

import { downloadCsv, reportFilename } from "../lib/csv.js";
import { fmtDateHuman, fmtPct, nInt } from "../lib/format.js";
import {
  ExportButton, FreshnessBar, Notice, Pagination, ReportHeader, SearchField, SelectField,
  SnapshotState, SortTh, StatRow, snapshotFreshnessLabel, sortRows, useSortState,
} from "./shared.jsx";

const PAGE_SIZE = 50;
const STATUS_OPTIONS = [
  { value: "ALL", label: "All movement states" },
  { value: "New", label: "New" },
  { value: "Rising", label: "Rising" },
  { value: "Stable", label: "Stable" },
  { value: "Declining", label: "Declining" },
  { value: "Dormant", label: "Dormant" },
  { value: "No Data", label: "No Data" },
];
const STATUS_STYLE = {
  New: { bg: "rgba(37,99,235,0.12)", fg: "#1d4ed8" },
  Rising: { bg: "rgba(30,150,80,0.14)", fg: "#1a7f45" },
  Stable: { bg: "rgba(100,116,139,0.14)", fg: "#475569" },
  Declining: { bg: "rgba(200,50,50,0.14)", fg: "#b32424" },
  Dormant: { bg: "rgba(210,140,0,0.14)", fg: "#a86a00" },
  "No Data": { bg: "rgba(148,163,184,0.14)", fg: "#64748b" },
};

// Sticky first two columns (ASIN/product + SKU): opaque backgrounds so scrolling numeric columns never show through.
const STICKY_BG = "var(--bg-elevated)";
const STICKY_HEAD_BG = "var(--bg-subtle)";
const C1 = 224; // width of the sticky ASIN/product column
const col1Td = { position: "sticky", left: 0, zIndex: 1, background: STICKY_BG, minWidth: C1, maxWidth: C1, textAlign: "left" };
const col1Th = { ...col1Td, top: 0, zIndex: 3, background: STICKY_HEAD_BG };
const col2Td = { position: "sticky", left: C1, zIndex: 1, background: STICKY_BG, minWidth: 150, maxWidth: 190, textAlign: "left" };
const col2Th = { ...col2Td, top: 0, zIndex: 3, background: STICKY_HEAD_BG };

// A units cell: null = the window is BEFORE the account's coverage (unavailable, em dash) -- never a fabricated 0.
const unitsCell = (v) => (v == null ? "—" : nInt(v));
const num = (v) => (Number(v) || 0);

const ACCESSORS = {
  productName: (r) => String(r.productName || r.asin || "").toLowerCase(),
  sku: (r) => String(r.sku || "").toLowerCase(),
  brand: (r) => String(r.brand || "").toLowerCase(),
  m0: (r) => (r.months?.[0]?.units ?? -1),
  m1: (r) => (r.months?.[1]?.units ?? -1),
  m2: (r) => (r.months?.[2]?.units ?? -1),
  mtd: (r) => num(r.mtdUnits),
  last5Total: (r) => num(r.last5Total),
  prev5Total: (r) => num(r.prev5Total),
  movementPercent: (r) => (r.movementPercent == null ? -Infinity : r.movementPercent),
  avgMonthlyUnits: (r) => (r.avgMonthlyUnits == null ? -1 : r.avgMonthlyUnits),
  mtdRunRate: (r) => (r.mtdRunRate == null ? -1 : r.mtdRunRate),
  projectedUnits: (r) => (r.projectedUnits == null ? -1 : r.projectedUnits),
  status: (r) => String(r.status || ""),
};

function StatusBadge({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE["No Data"];
  return (
    <span style={{ padding: "1px 9px", borderRadius: 10, fontSize: 11, fontWeight: 700, background: s.bg, color: s.fg, whiteSpace: "nowrap" }}>
      {status}
    </span>
  );
}

export default function SkuMovement({ data, loading, updating, error, accountName, selectedBrand, onReload, cachedAt }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("ALL");
  const [page, setPage] = useState(1);
  const [sort, onSort] = useSortState("last5Total", ["productName", "sku", "brand", "status"]);

  const rows = useMemo(() => (data && Array.isArray(data.rows) ? data.rows : []), [data]);
  const monthLabels = (data && data.monthLabels) || ["", "", ""];
  const mtdLabel = (data && data.mtdLabel) || "MTD";
  const last5Dates = (data && Array.isArray(data.last5Dates)) ? data.last5Dates : [];
  const thresholds = (data && data.thresholds) || { risingPct: 20, decliningPct: -20 };
  const completeness = data && data.completeness ? data.completeness : null;

  // Search + status filter are the ONLY things that reduce the row set; both are local.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (status !== "ALL" && r.status !== status) return false;
      if (!q) return true;
      return `${r.asin || ""} ${r.sku || ""} ${r.productName || ""} ${r.brand || ""}`.toLowerCase().includes(q);
    });
  }, [rows, search, status]);

  const sorted = useMemo(() => sortRows(filtered, ACCESSORS, sort, "last5Total"), [filtered, sort]);

  // Reset to page 1 whenever the scope or filters change the result set.
  useEffect(() => { setPage(1); }, [search, status, data]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageRows = useMemo(() => sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [sorted, page]);

  // Totals over the CURRENT scope (all filtered rows, not just this page). Months sum only their AVAILABLE cells.
  const totals = useMemo(() => {
    const t = { months: [null, null, null], mtd: 0, last5: 0, prev5: 0, last5ByDate: last5Dates.map(() => 0) };
    for (const r of filtered) {
      (r.months || []).forEach((m, i) => { if (m && m.units != null) t.months[i] = (t.months[i] || 0) + m.units; });
      t.mtd += num(r.mtdUnits); t.last5 += num(r.last5Total); t.prev5 += num(r.prev5Total);
      (r.last5Dates || []).forEach((d, i) => { t.last5ByDate[i] += num(d.units); });
    }
    t.movementPercent = t.prev5 > 0 ? Math.round(((t.last5 - t.prev5) / t.prev5) * 1000) / 10 : null;
    return t;
  }, [filtered, last5Dates]);

  const scopeLabel = `${accountName || "the selected account"}${selectedBrand === "ALL" ? "" : ` · ${selectedBrand}`}`;
  const state = <SnapshotState data={data} loading={loading} error={error} label="SKU Movement report" icon={<Activity size={22} />} />;

  const exportTable = () => {
    const out = sorted.map((r) => {
      const rec = {
        "Product Name": r.productName || "", ASIN: r.asin || "", SKU: r.sku || "", Brand: r.brand || "",
      };
      (r.months || []).forEach((m, i) => { rec[`${monthLabels[i] || m.label || `Month ${i + 1}`} units`] = m.units == null ? "" : Math.round(m.units); });
      rec[`${mtdLabel} units`] = Math.round(num(r.mtdUnits));
      (r.last5Dates || []).forEach((d) => { rec[`${d.date} units`] = Math.round(num(d.units)); });
      rec["Last 5 units"] = Math.round(num(r.last5Total));
      rec["Previous 5 units"] = Math.round(num(r.prev5Total));
      rec["Movement %"] = r.movementPercent == null ? "" : r.movementPercent.toFixed(1);
      rec["Avg monthly units"] = r.avgMonthlyUnits == null ? "" : r.avgMonthlyUnits;
      rec["MTD run rate (units/day)"] = r.mtdRunRate == null ? "" : r.mtdRunRate;
      rec["Projected month units"] = r.projectedUnits == null ? "" : r.projectedUnits;
      rec["Movement status"] = r.status || "";
      return rec;
    });
    downloadCsv(out, reportFilename("sku-movement", accountName, data?.effectiveAsOf));
  };

  return (
    <div className="container skupl-page">
      <ReportHeader
        title="SKU Movement"
        subtitle={`Per-ASIN/SKU units, momentum and month projection for ${scopeLabel} — built from saved order data only, no export`}
      />

      {state}

      {data && !data.snapshotMissing && (
        <FreshnessBar items={[
          `effective through ${fmtDateHuman(data.effectiveAsOf)} (the account's latest proven order date)`,
          `completed months ${monthLabels.join(" · ")}`,
          `${mtdLabel}${last5Dates.length ? ` · last 5 days ${fmtDateHuman(last5Dates[0])} – ${fmtDateHuman(last5Dates[last5Dates.length - 1])}` : ""}`,
          snapshotFreshnessLabel(data),
          ...(completeness ? [completeness.provisional
            ? `Provisional D-1 · ${completeness.itemizationPercent}% itemized · ${completeness.pendingOrderCount} orders pending`
            : (completeness.sourceDefect ? "Source issue on D-1" : "Final D-1")] : []),
        ]} />
      )}

      {completeness && completeness.provisional && (
        <Notice tone="warn">
          The most recent day ({fmtDateHuman(completeness.latestDate || data?.effectiveAsOf)}) is <strong>provisional</strong>: {completeness.itemizationPercent}% of its orders are itemized and {completeness.pendingOrderCount} are still pending at the source. Units for that day may rise as Amazon settles them; nothing is fabricated.
        </Notice>
      )}

      {data && data.snapshotMissing && (
        <Notice tone={data.waitingForScheduledData ? "info" : "warn"}>
          {data.message || "No saved SKU Movement for this account yet — it will appear after the next saved order refresh. No export is created."}
        </Notice>
      )}

      {data && !data.snapshotMissing && data.brandFiltered && rows.length === 0 && (
        <Notice tone="info">
          No catalog-proven SKUs are mapped to <strong>{data.brand}</strong> for this account, so this brand's SKU Movement is empty. (This is a valid empty result — it is never filled from the account's other brands.)
        </Notice>
      )}

      {data && !data.snapshotMissing && rows.length > 0 && <>
        <StatRow stats={[
          { label: "SKUs in scope", value: nInt(rows.length) },
          { label: `${mtdLabel} units`, value: nInt(totals.mtd) },
          { label: "Last 5-day units", value: nInt(totals.last5) },
          { label: "Previous 5-day units", value: nInt(totals.prev5) },
          { label: "Movement", value: fmtPct(totals.movementPercent), tone: totals.movementPercent == null ? undefined : (totals.movementPercent > 0 ? "good" : totals.movementPercent < 0 ? "bad" : undefined) },
        ]} />

        <div className="panel skupl-table-panel" style={{ padding: 0, overflow: "hidden" }}>
          <div className="skupl-toolbar">
            <SearchField value={search} onChange={setSearch} placeholder="ASIN, SKU, product, or brand" />
            <SelectField label="Movement" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
            <div className="skupl-toolbar-spacer" />
            {onReload && (
              <button type="button" className="cache-refresh-btn" onClick={onReload} disabled={updating} title="Re-read the latest saved data. This never creates an export.">
                <RefreshCw size={14} />{updating ? "Reloading…" : "Reload latest data"}
              </button>
            )}
            <ExportButton onClick={exportTable} disabled={!sorted.length} />
          </div>
          <div className="plan-scroll">
            <table className="plan-table" style={{ minWidth: 1280 }}>
              <thead>
                <tr>
                  <SortTh style={col1Th} label="Product / ASIN" col="productName" sort={sort} onSort={onSort} align="left" />
                  <SortTh style={col2Th} label="SKU" col="sku" sort={sort} onSort={onSort} align="left" />
                  <SortTh label={monthLabels[0]} col="m0" sort={sort} onSort={onSort} />
                  <SortTh label={monthLabels[1]} col="m1" sort={sort} onSort={onSort} />
                  <SortTh label={monthLabels[2]} col="m2" sort={sort} onSort={onSort} />
                  <SortTh label={mtdLabel} col="mtd" sort={sort} onSort={onSort} />
                  {last5Dates.map((d) => (
                    <th key={d} title={fmtDateHuman(d)} style={{ textAlign: "right", whiteSpace: "nowrap" }}>{d.slice(5)}</th>
                  ))}
                  <SortTh label="Last 5" col="last5Total" sort={sort} onSort={onSort} hint="Units over the latest five dates" />
                  <SortTh label="Prev 5" col="prev5Total" sort={sort} onSort={onSort} hint="Units over the five dates before that" />
                  <SortTh label="Move %" col="movementPercent" sort={sort} onSort={onSort} hint={`(Last5 − Prev5) ÷ Prev5. Rising > +${thresholds.risingPct}%, Declining < ${thresholds.decliningPct}%`} />
                  <SortTh label="Avg / mo" col="avgMonthlyUnits" sort={sort} onSort={onSort} hint="Average units across the available completed months" />
                  <SortTh label="Run rate" col="mtdRunRate" sort={sort} onSort={onSort} hint="MTD units ÷ days elapsed this month" />
                  <SortTh label="Projected" col="projectedUnits" sort={sort} onSort={onSort} hint="Run rate × days in the current month" />
                  <SortTh label="Status" col="status" sort={sort} onSort={onSort} align="left" />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr key={`${r.asin} ${r.sku}`}>
                    <td style={col1Td}>
                      <div style={{ fontWeight: 650, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: C1 }} title={r.productName || ""}>{r.productName || <span style={{ color: "var(--text-secondary)" }}>—</span>}</div>
                      <div className="mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>{r.asin || "—"}{r.brand ? ` · ${r.brand}` : ""}</div>
                    </td>
                    <td className="mono" style={col2Td} title={r.sku || ""}>{r.sku || "—"}</td>
                    {(r.months || []).map((m, i) => <td key={i} className="mono">{unitsCell(m.units)}</td>)}
                    <td className="mono pt-strong">{nInt(num(r.mtdUnits))}</td>
                    {(r.last5Dates || []).map((d) => <td key={d.date} className="mono">{nInt(num(d.units))}</td>)}
                    <td className="mono pt-strong">{nInt(num(r.last5Total))}</td>
                    <td className="mono">{nInt(num(r.prev5Total))}</td>
                    <td className={"mono" + (r.movementPercent == null ? "" : r.movementPercent > 0 ? " sku-pos" : r.movementPercent < 0 ? " sku-neg" : "")}>{fmtPct(r.movementPercent)}</td>
                    <td className="mono">{r.avgMonthlyUnits == null ? "—" : r.avgMonthlyUnits}</td>
                    <td className="mono">{r.mtdRunRate == null ? "—" : r.mtdRunRate}</td>
                    <td className="mono">{r.projectedUnits == null ? "—" : nInt(r.projectedUnits)}</td>
                    <td><StatusBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700, borderTop: "2px solid var(--border-strong)" }}>
                  <td style={{ ...col1Td, fontWeight: 700 }}>Totals · {nInt(filtered.length)} SKU{filtered.length === 1 ? "" : "s"}</td>
                  <td style={col2Td}></td>
                  {totals.months.map((v, i) => <td key={i} className="mono">{unitsCell(v)}</td>)}
                  <td className="mono">{nInt(totals.mtd)}</td>
                  {totals.last5ByDate.map((v, i) => <td key={i} className="mono">{nInt(v)}</td>)}
                  <td className="mono">{nInt(totals.last5)}</td>
                  <td className="mono">{nInt(totals.prev5)}</td>
                  <td className={"mono" + (totals.movementPercent == null ? "" : totals.movementPercent > 0 ? " sku-pos" : totals.movementPercent < 0 ? " sku-neg" : "")}>{fmtPct(totals.movementPercent)}</td>
                  <td colSpan={4}></td>
                </tr>
              </tfoot>
            </table>
          </div>
          {!sorted.length && (
            <div className="empty-note" style={{ padding: "14px 16px" }}>
              {rows.length ? "No SKUs match this search or movement filter." : "No SKUs found for this scope."}
            </div>
          )}
          {pageCount > 1 && (
            <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border-default)" }}>
              <Pagination page={page} pageCount={pageCount} onChange={setPage} />
            </div>
          )}
        </div>

        <div className="footer-note">
          Units come from the durable Order Line Items rollup (<code>source_oli_daily_history</code>) — the same saved orders every other report uses — summed per ASIN + SKU after the established contribution rules (cancelled orders contribute zero; explicit-zero days are honest zeros; unpriced/pending units are never counted and never fabricated). The three completed months, the {mtdLabel} window, and the two 5-day windows are all computed from this account's latest proven order date ({fmtDateHuman(data.effectiveAsOf)}), never from your browser's clock. A month entirely before this account's order coverage shows an em dash (unavailable), never a zero. Movement % is (Last 5 − Previous 5) ÷ Previous 5; a SKU is <strong>Rising</strong> above +{thresholds.risingPct}% and <strong>Declining</strong> below {thresholds.decliningPct}%. Run rate is {mtdLabel} units ÷ days elapsed, and the projection is that rate across the whole month. Search, sort, the movement filter and paging are all local — they never refetch — and reloading only re-reads saved data. No action on this page ever creates a DataDoe export.
        </div>
      </>}
    </div>
  );
}
