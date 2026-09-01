// SKU Movement (v2) -- a per-ASIN units + trend + month-projection report, rendered ENTIRELY from the durable,
// zero-export sku-movement/v2 snapshot (the account's enriched ORDERED-unit history + Product Catalog). One row per
// account + marketplace + currency + ASIN (multiple SKUs aggregate). The recent/comparison window defaults to 7 and
// is user-selectable (1..30): Last N / Previous N are recomputed CLIENT-side from the saved daily history with the
// SAME shared math the server used -- never a refetch, never DataDoe. A manual per-(account, ASIN) Identifier column
// (before SKU) is inline-editable + bulk import/export; a column chooser + the N choice persist per user. Every
// filter/sort/search/page/export is LOCAL. A named-brand empty result is a VALID empty report, never All-Brands.

import React, { useMemo, useState, useEffect, useRef } from "react";
import { Activity, RefreshCw, SlidersHorizontal, Upload, Download, Check, X, Pencil } from "lucide-react";

import { downloadCsv, reportFilename } from "../lib/csv.js";
import { fmtDateHuman, fmtPct, nInt } from "../lib/format.js";
import {
  ExportButton, FreshnessBar, Notice, Pagination, ReportHeader, SearchField, SelectField,
  SnapshotState, SortTh, snapshotFreshnessLabel, sortRows, useSortState,
} from "./shared.jsx";
import { GradientKpi, ObservedUnitsBreakdown } from "../components/ui.jsx";
import {
  computeRowWindow, recentPrevDates, clampRecentDays, DEFAULT_RECENT_DAYS, MAX_RECENT_DAYS, MIN_RECENT_DAYS,
} from "../../lib/sku-movement-window.js";
import { validateIdentifierImport, validateIdentifierRows, buildIdentifierTemplateCsv, MAX_IDENTIFIER_LEN } from "../lib/sku-movement-import.js";

const PAGE_SIZE = 50;
const STATUS_OPTIONS = [
  { value: "ALL", label: "All movement states" },
  ...["New", "Rising", "Stable", "Declining", "Dormant", "No Data"].map((v) => ({ value: v, label: v })),
];
const STATUS_STYLE = {
  New: { bg: "rgba(37,99,235,0.12)", fg: "#1d4ed8" }, Rising: { bg: "rgba(30,150,80,0.14)", fg: "#1a7f45" },
  Stable: { bg: "rgba(100,116,139,0.14)", fg: "#475569" }, Declining: { bg: "rgba(200,50,50,0.14)", fg: "#b32424" },
  Dormant: { bg: "rgba(210,140,0,0.14)", fg: "#a86a00" }, "No Data": { bg: "rgba(148,163,184,0.14)", fg: "#64748b" },
};

// Sticky first THREE columns (ASIN/product, Identifier, SKU): opaque so scrolling numeric columns never show through.
const STICKY_BG = "var(--bg-elevated)";
const STICKY_HEAD_BG = "var(--op-navy)"; // premium deep-navy sticky identity header (matches the op-report theme)
const C1 = 210, C2 = 140; // ASIN/product column, Identifier column
const sticky = (left, w) => ({ position: "sticky", left, zIndex: 1, background: STICKY_BG, minWidth: w, maxWidth: w, textAlign: "left" });
const stickyHead = (left, w) => ({ ...sticky(left, w), top: 0, zIndex: 3, background: STICKY_HEAD_BG });
const col1Td = sticky(0, C1), col1Th = stickyHead(0, C1);
const col2Td = sticky(C1, C2), col2Th = stickyHead(C1, C2);
const col3Td = { ...sticky(C1 + C2, 150), maxWidth: 190 }, col3Th = { ...stickyHead(C1 + C2, 150), maxWidth: 190 };

const num = (v) => (Number(v) || 0);

// Optional (hideable) columns. ASIN/product is the identity column and is NEVER hideable.
const OPTIONAL_COLUMNS = [
  { key: "identifier", label: "Identifier", group: "Identity" },
  { key: "sku", label: "SKU", group: "Identity" },
  { key: "brand", label: "Brand", group: "Identity" },
  { key: "months", label: "Completed months", group: "Completed Months" },
  { key: "mtd", label: "MTD", group: "MTD" },
  { key: "daily", label: "Recent daily dates", group: "Recent Daily" },
  { key: "prev", label: "Previous N", group: "Comparison" },
  { key: "move", label: "Move %", group: "Comparison" },
  { key: "avg", label: "Avg / month", group: "Forecast" },
  { key: "runRate", label: "Run rate", group: "Forecast" },
  { key: "projected", label: "Projected", group: "Forecast" },
  { key: "status", label: "Status", group: "Status" },
];
const GROUPS = ["Identity", "Completed Months", "MTD", "Recent Daily", "Comparison", "Forecast", "Status"];

function StatusBadge({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE["No Data"];
  return <span style={{ padding: "1px 9px", borderRadius: 10, fontSize: 11, fontWeight: 700, background: s.bg, color: s.fg, whiteSpace: "nowrap" }}>{status}</span>;
}
function MoveBadge({ value }) {
  if (value == null) return <span className="sku-mv-move-flat">{fmtPct(value)}</span>;
  const cls = value > 0 ? "sku-mv-move-pos" : value < 0 ? "sku-mv-move-neg" : "sku-mv-move-flat";
  return <span className={"sku-mv-move " + cls}>{fmtPct(value)}</span>;
}

// Inline identifier editor: a small text field with save/clear; commits on Enter/blur, cancels on Escape.
function IdentifierCell({ value, asin, canEdit, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");
  const ref = useRef(null);
  useEffect(() => { setDraft(value || ""); }, [value]);
  useEffect(() => { if (editing && ref.current) ref.current.focus(); }, [editing]);
  if (!canEdit) return <span className="mono" style={{ fontSize: 12 }}>{value || <span style={{ color: "var(--text-secondary)" }}>—</span>}</span>;
  if (!editing) {
    return (
      <button type="button" className="sku-mv-ident-view" title="Edit identifier" onClick={() => setEditing(true)}
        style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", color: "inherit", padding: 0, maxWidth: C2 - 6, textAlign: "left" }}>
        <span className="mono" style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value || <span style={{ color: "var(--text-secondary)" }}>—</span>}</span>
        <Pencil size={11} style={{ opacity: 0.5, flexShrink: 0 }} />
      </button>
    );
  }
  const commit = () => { const v = draft.trim().slice(0, MAX_IDENTIFIER_LEN); setEditing(false); if (v !== (value || "")) onSave(asin, v); };
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <input ref={ref} value={draft} maxLength={MAX_IDENTIFIER_LEN}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(value || ""); setEditing(false); } }}
        onBlur={commit}
        style={{ width: C2 - 40, fontSize: 12, padding: "2px 5px", borderRadius: 5, border: "1px solid var(--border-strong)", background: "var(--bg-input, #fff)", color: "inherit" }}
        placeholder="identifier" aria-label={`Identifier for ${asin}`} />
      <button type="button" title="Save" onMouseDown={(e) => e.preventDefault()} onClick={commit} style={{ border: "none", background: "none", cursor: "pointer", color: "#1a7f45" }}><Check size={14} /></button>
    </span>
  );
}

// Column chooser popover: grouped checkboxes + Select all + Reset default (ASIN is locked/always visible).
function ColumnChooser({ hidden, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => { const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, []);
  const hiddenSet = new Set(hidden);
  const toggle = (key) => { const s = new Set(hiddenSet); if (s.has(key)) s.delete(key); else s.add(key); onChange([...s]); };
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" className="cache-refresh-btn" onClick={() => setOpen((o) => !o)} title="Choose visible columns"><SlidersHorizontal size={14} />Columns</button>
      {open && (
        <div className="panel" style={{ position: "absolute", right: 0, top: "110%", zIndex: 30, width: 250, padding: 12, maxHeight: "70vh", overflowY: "auto", boxShadow: "0 8px 30px rgba(0,0,0,0.25)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <button type="button" className="link-btn" onClick={() => onChange([])}>Select all</button>
            <button type="button" className="link-btn" onClick={() => onChange([])}>Reset default</button>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 6 }}>ASIN / Product is always shown.</div>
          {GROUPS.map((g) => {
            const cols = OPTIONAL_COLUMNS.filter((c) => c.group === g);
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

// Bulk identifier import modal: download the current scope as a template, upload CSV/XLSX, preview valid/errors,
// apply only when clean (atomic). ASIN is the match key; a blank identifier value clears that ASIN.
function BulkIdentifierModal({ rows, accountName, onClose, onApply }) {
  const [parsed, setParsed] = useState(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [applyErr, setApplyErr] = useState(null);
  const onFile = async (file) => {
    if (!file) return;
    setFileName(file.name); setApplyErr(null);
    try {
      if (/\.xlsx$/i.test(file.name)) {
        const { readXlsxFirstSheet } = await import("../lib/xlsx-read.js");
        const grid = await readXlsxFirstSheet(await file.arrayBuffer());
        setParsed(validateIdentifierRows(grid));
      } else {
        setParsed(validateIdentifierImport(await file.text()));
      }
    } catch (e) { setApplyErr(String(e && e.message ? e.message : e)); setParsed(null); }
  };
  const downloadTemplate = () => {
    const csv = buildIdentifierTemplateCsv({ accountName, rows });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `sku-movement-identifiers-${(accountName || "account").replace(/[^a-z0-9]+/gi, "-")}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };
  const missingCol = parsed && (parsed.missingAsinColumn || parsed.missingIdentifierColumn);
  const clean = parsed && !missingCol && parsed.errors.length === 0 && parsed.valid.length > 0;
  const apply = async () => {
    if (!clean) return;
    setBusy(true); setApplyErr(null);
    try { await onApply(parsed.valid.map((r) => ({ childAsin: r.asin, identifier: r.identifier }))); onClose(); }
    catch (e) { setApplyErr(String(e && e.message ? e.message : e)); } finally { setBusy(false); }
  };
  return (
    <div className="modal-backdrop" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div className="panel" style={{ width: "min(680px, 96vw)", maxHeight: "88vh", overflowY: "auto", padding: 18 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Bulk identifiers</h3>
          <button type="button" onClick={onClose} style={{ border: "none", background: "none", cursor: "pointer", color: "inherit" }}><X size={18} /></button>
        </div>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 0 }}>
          Download the current scope, edit the <strong>Identifier</strong> column, then upload. Rows match on <strong>ASIN</strong> (SKU is informational and never remaps an ASIN). A blank identifier clears that ASIN. Any invalid row means nothing is written.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
          <button type="button" className="cache-refresh-btn" onClick={downloadTemplate}><Download size={14} />Download template ({rows.length})</button>
          <label className="cache-refresh-btn" style={{ cursor: "pointer" }}>
            <Upload size={14} />{fileName ? `Re-choose (${fileName})` : "Upload CSV / XLSX"}
            <input type="file" accept=".csv,.tsv,.xlsx,text/csv" style={{ display: "none" }} onChange={(e) => onFile(e.target.files && e.target.files[0])} />
          </label>
        </div>
        {missingCol && <Notice tone="warn">The file must include an <strong>ASIN</strong> column and an <strong>Identifier</strong> column. (A missing Identifier column is never treated as "clear everything".)</Notice>}
        {parsed && !missingCol && (
          <div style={{ fontSize: 13, marginBottom: 10 }}>
            <div><strong>{parsed.valid.length}</strong> valid row(s){parsed.errors.length ? <>, <span style={{ color: "#b32424" }}><strong>{parsed.errors.length}</strong> error(s)</span></> : null}.</div>
            {parsed.errors.slice(0, 6).map((e, i) => <div key={i} style={{ color: "#b32424", fontSize: 12 }}>Line {e.line} ({e.asin || "?"}): {e.problems.join("; ")}</div>)}
            {parsed.errors.length > 6 && <div style={{ color: "#b32424", fontSize: 12 }}>…and {parsed.errors.length - 6} more.</div>}
          </div>
        )}
        {applyErr && <Notice tone="warn">{applyErr}</Notice>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
          <button type="button" className="cache-refresh-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" disabled={!clean || busy} onClick={apply} title={clean ? "Apply all valid rows atomically" : "Fix errors first"}>{busy ? "Applying…" : `Apply ${parsed ? parsed.valid.length : 0}`}</button>
        </div>
      </div>
    </div>
  );
}

export default function SkuMovement({ data, loading, updating, error, accountName, selectedBrand, onReload, cachedAt, recentDays = DEFAULT_RECENT_DAYS, onRecentDaysChange, hiddenColumns = [], onColumnsChange, onSaveIdentifier, onBulkIdentifiers, canEdit = false }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("ALL");
  const [page, setPage] = useState(1);
  const [sort, onSort] = useSortState("recentTotal", ["productName", "identifier", "sku", "brand", "status"]);
  const [bulkOpen, setBulkOpen] = useState(false);

  const N = clampRecentDays(recentDays);
  const rawRows = useMemo(() => (data && Array.isArray(data.rows) ? data.rows : []), [data]);
  const dailyDates = (data && Array.isArray(data.dailyDates)) ? data.dailyDates : [];
  const monthLabels = (data && data.monthLabels) || ["", "", ""];
  const mtdLabel = (data && data.mtdLabel) || "MTD";
  const thresholds = (data && data.thresholds) || { risingPct: 20, decliningPct: -20 };
  const completeness = data && data.completeness ? data.completeness : null;
  const maxN = (data && data.maxRecentDays) || MAX_RECENT_DAYS;
  const hiddenSet = useMemo(() => new Set(hiddenColumns), [hiddenColumns]);
  const shown = (key) => !hiddenSet.has(key);

  // The N recent daily-date columns (from the shared axis).
  const recentCols = useMemo(() => recentPrevDates(dailyDates, N).recentDates, [dailyDates, N]);

  // CLIENT-side recompute of Last N / Previous N / move% / status for the chosen N (same shared math as the server).
  const rows = useMemo(() => rawRows.map((r) => {
    const w = computeRowWindow({ dailyUnits: r.dailyUnits || {}, monthsTotalUnits: r.monthsTotalUnits, mtdUnits: r.mtdUnits }, dailyDates, N);
    return { ...r, recentTotal: w.lastTotal, prevTotal: w.prevTotal, movementPercent: w.movementPercent, status: w.status };
  }), [rawRows, dailyDates, N]);

  const ACCESSORS = useMemo(() => ({
    productName: (r) => String(r.productName || r.asin || "").toLowerCase(),
    identifier: (r) => String(r.identifier || "").toLowerCase(),
    sku: (r) => String(r.sku || "").toLowerCase(),
    brand: (r) => String(r.brand || "").toLowerCase(),
    m0: (r) => (r.months?.[0]?.units ?? -1), m1: (r) => (r.months?.[1]?.units ?? -1), m2: (r) => (r.months?.[2]?.units ?? -1),
    mtd: (r) => num(r.mtdUnits), recentTotal: (r) => num(r.recentTotal), prevTotal: (r) => num(r.prevTotal),
    movementPercent: (r) => (r.movementPercent == null ? -Infinity : r.movementPercent),
    avgMonthlyUnits: (r) => (r.avgMonthlyUnits == null ? -1 : r.avgMonthlyUnits),
    mtdRunRate: (r) => (r.mtdRunRate == null ? -1 : r.mtdRunRate),
    projectedUnits: (r) => (r.projectedUnits == null ? -1 : r.projectedUnits),
    status: (r) => String(r.status || ""),
  }), []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (status !== "ALL" && r.status !== status) return false;
      if (!q) return true;
      return `${r.asin || ""} ${r.identifier || ""} ${r.sku || ""} ${r.productName || ""} ${r.brand || ""}`.toLowerCase().includes(q);
    });
  }, [rows, search, status]);
  const sorted = useMemo(() => sortRows(filtered, ACCESSORS, sort, "recentTotal"), [filtered, sort, ACCESSORS]);
  useEffect(() => { setPage(1); }, [search, status, data]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageRows = useMemo(() => sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [sorted, page]);

  const totals = useMemo(() => {
    const t = { months: [null, null, null], mtd: 0, recent: 0, prev: 0, byDate: recentCols.map(() => 0) };
    for (const r of filtered) {
      (r.months || []).forEach((m, i) => { if (m && m.units != null) t.months[i] = (t.months[i] || 0) + m.units; });
      t.mtd += num(r.mtdUnits); t.recent += num(r.recentTotal); t.prev += num(r.prevTotal);
      recentCols.forEach((d, i) => { t.byDate[i] += num((r.dailyUnits || {})[d]); });
    }
    t.movementPercent = t.prev > 0 ? Math.round(((t.recent - t.prev) / t.prev) * 1000) / 10 : null;
    return t;
  }, [filtered, recentCols]);

  const scopeLabel = `${accountName || "the selected account"}${selectedBrand === "ALL" ? "" : ` · ${selectedBrand}`}`;
  const state = <SnapshotState data={data} loading={loading} error={error} label="SKU Movement report" icon={<Activity size={22} />} />;
  const dailyUnitAt = (r, d) => { const c = dailyDates.length && data && data.coverageFrom && d < data.coverageFrom ? null : num((r.dailyUnits || {})[d]); return c; };

  const exportTable = () => {
    const out = sorted.map((r) => {
      const rec = {};
      rec.ASIN = r.asin || "";
      if (shown("identifier")) rec.Identifier = r.identifier || "";
      rec["Product Name"] = r.productName || "";
      if (shown("sku")) rec.SKU = r.hasSellerSku ? r.sku : "";
      if (shown("brand")) rec.Brand = r.brand || "";
      if (shown("months")) (r.months || []).forEach((m, i) => { rec[`${monthLabels[i] || m.label || `Month ${i + 1}`} units`] = m.units == null ? "" : Math.round(m.units); });
      if (shown("mtd")) rec[`${mtdLabel} units`] = Math.round(num(r.mtdUnits));
      if (shown("daily")) recentCols.forEach((d) => { rec[`${d} units`] = Math.round(num((r.dailyUnits || {})[d])); });
      rec[`Last ${N} units`] = Math.round(num(r.recentTotal));
      if (shown("prev")) rec[`Previous ${N} units`] = Math.round(num(r.prevTotal));
      if (shown("move")) rec["Movement %"] = r.movementPercent == null ? "" : r.movementPercent.toFixed(1);
      if (shown("avg")) rec["Avg monthly units"] = r.avgMonthlyUnits == null ? "" : r.avgMonthlyUnits;
      if (shown("runRate")) rec["MTD run rate (units/day)"] = r.mtdRunRate == null ? "" : r.mtdRunRate;
      if (shown("projected")) rec["Projected month units"] = r.projectedUnits == null ? "" : r.projectedUnits;
      if (shown("status")) rec["Movement status"] = r.status || "";
      return rec;
    });
    downloadCsv(out, reportFilename("sku-movement", accountName, data?.effectiveAsOf));
  };

  const nOptions = useMemo(() => { const o = []; for (let i = MIN_RECENT_DAYS; i <= maxN; i += 1) o.push({ value: String(i), label: `${i} day${i === 1 ? "" : "s"}` }); return o; }, [maxN]);

  return (
    <div className="container skupl-page sku-mv-page op-report">
      <ReportHeader title="SKU Movement" subtitle={`Per-ASIN units, momentum and month projection for ${scopeLabel} — built from saved order data only, no export`} />
      {state}

      {data && !data.snapshotMissing && (
        <FreshnessBar items={[
          `effective through ${fmtDateHuman(data.effectiveAsOf)} (the account's latest proven order date)`,
          `completed months ${monthLabels.join(" · ")}`,
          `${mtdLabel}${recentCols.length ? ` · last ${N} day${N === 1 ? "" : "s"} ${fmtDateHuman(recentCols[0])} – ${fmtDateHuman(recentCols[recentCols.length - 1])}` : ""}`,
          snapshotFreshnessLabel(data),
          ...(completeness ? [completeness.provisional ? `Provisional D-1 · ${completeness.itemizationPercent}% itemized · ${completeness.pendingOrderCount} orders pending` : (completeness.sourceDefect ? "Source issue on D-1" : "Final D-1")] : []),
        ]} />
      )}

      {completeness && completeness.unitBreakdown && <ObservedUnitsBreakdown completeness={completeness} />}
      {completeness && completeness.provisional && (
        <Notice tone="warn">The most recent day ({fmtDateHuman(completeness.latestDate || data?.effectiveAsOf)}) is <strong>provisional</strong>: {completeness.itemizationPercent}% of its orders are itemized and {completeness.pendingOrderCount} are still pending. Units may rise as Amazon settles them; nothing is fabricated.</Notice>
      )}
      {data && data.snapshotMissing && (
        <Notice tone={data.waitingForScheduledData ? "info" : "warn"}>{data.message || "No saved SKU Movement for this account yet — it will appear after the next saved order refresh. No export is created."}</Notice>
      )}
      {data && !data.snapshotMissing && data.brandFiltered && rawRows.length === 0 && (
        <Notice tone="info">No catalog-proven ASINs are mapped to <strong>{data.brand}</strong> for this account, so this brand's SKU Movement is empty. (This is a valid empty result — it is never filled from the account's other brands.)</Notice>
      )}

      {data && !data.snapshotMissing && rawRows.length > 0 && <>
        <div className="rvkpi-grid rvkpi-grid-5">
          <GradientKpi label="ASINs in scope" value={nInt(rawRows.length)} />
          <GradientKpi label={`${mtdLabel} units`} value={nInt(totals.mtd)} gradient="linear-gradient(135deg,#FF6B6B,#FF8E53)" />
          <GradientKpi label={`Last ${N}-day units`} value={nInt(totals.recent)} gradient="linear-gradient(135deg,#A78BFA,#7C3AED)" />
          <GradientKpi label={`Previous ${N}-day units`} value={nInt(totals.prev)} />
          <GradientKpi label="Movement" value={fmtPct(totals.movementPercent)} sub={`vs previous ${N} days`} tone={totals.movementPercent == null ? undefined : (totals.movementPercent > 0 ? "good" : totals.movementPercent < 0 ? "bad" : undefined)} />
        </div>

        <div className="panel skupl-table-panel" style={{ padding: 0, overflow: "hidden" }}>
          <div className="skupl-toolbar" style={{ flexWrap: "wrap", gap: 8 }}>
            <SearchField value={search} onChange={setSearch} placeholder="ASIN, identifier, SKU, product, or brand" />
            <SelectField label="Movement" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
            <SelectField label="Window" value={String(N)} onChange={(v) => onRecentDaysChange && onRecentDaysChange(clampRecentDays(v))} options={nOptions} />
            <div className="skupl-toolbar-spacer" />
            {onColumnsChange && <ColumnChooser hidden={hiddenColumns} onChange={onColumnsChange} />}
            {canEdit && onBulkIdentifiers && <button type="button" className="cache-refresh-btn" onClick={() => setBulkOpen(true)} title="Download / upload identifiers"><Upload size={14} />Identifiers</button>}
            {onReload && <button type="button" className="cache-refresh-btn" onClick={onReload} disabled={updating} title="Re-read the latest saved data. This never creates an export."><RefreshCw size={14} />{updating ? "Reloading…" : "Reload"}</button>}
            <ExportButton onClick={exportTable} disabled={!sorted.length} />
          </div>
          <div className="plan-scroll">
            <table className="plan-table sku-mv" style={{ minWidth: 900 + recentCols.length * 52 }}>
              <thead>
                <tr>
                  <SortTh style={col1Th} label="Product / ASIN" col="productName" sort={sort} onSort={onSort} align="left" />
                  {shown("identifier") && <SortTh style={col2Th} label="Identifier" col="identifier" sort={sort} onSort={onSort} align="left" hint="Your manual per-ASIN label (editable)" />}
                  {shown("sku") && <SortTh style={shown("identifier") ? col3Th : col2Th} label="SKU" col="sku" sort={sort} onSort={onSort} align="left" hint="Representative seller SKU (amzn return SKUs excluded)" />}
                  {shown("brand") && <th style={{ textAlign: "left" }}>Brand</th>}
                  {shown("months") && monthLabels.map((l, i) => <SortTh key={i} label={l} col={`m${i}`} sort={sort} onSort={onSort} />)}
                  {shown("mtd") && <SortTh className="sku-mv-mtd" label={mtdLabel} col="mtd" sort={sort} onSort={onSort} />}
                  {shown("daily") && recentCols.map((d) => <th key={d} title={fmtDateHuman(d)} style={{ textAlign: "right", whiteSpace: "nowrap" }}>{d.slice(5)}</th>)}
                  <SortTh className="sku-mv-last5" label={`Last ${N}`} col="recentTotal" sort={sort} onSort={onSort} hint={`Units over the latest ${N} dates`} />
                  {shown("prev") && <SortTh label={`Prev ${N}`} col="prevTotal" sort={sort} onSort={onSort} hint={`Units over the ${N} dates before that`} />}
                  {shown("move") && <SortTh label="Move %" col="movementPercent" sort={sort} onSort={onSort} hint={`(Last ${N} − Prev ${N}) ÷ Prev ${N}. Rising > +${thresholds.risingPct}%, Declining < ${thresholds.decliningPct}%`} />}
                  {shown("avg") && <SortTh label="Avg / mo" col="avgMonthlyUnits" sort={sort} onSort={onSort} hint="Average units across the available completed months" />}
                  {shown("runRate") && <SortTh label="Run rate" col="mtdRunRate" sort={sort} onSort={onSort} hint="MTD units ÷ days elapsed this month" />}
                  {shown("projected") && <SortTh label="Projected" col="projectedUnits" sort={sort} onSort={onSort} hint="Run rate × days in the current month" />}
                  {shown("status") && <SortTh label="Status" col="status" sort={sort} onSort={onSort} align="left" />}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr key={`${r.asin}|${r.currency || ""}`}>
                    <td style={col1Td}>
                      <div style={{ fontWeight: 650, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: C1 }} title={r.productName || ""}>{r.productName || <span style={{ color: "var(--text-secondary)" }}>—</span>}</div>
                      <div className="mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>{r.asin || "—"}{r.currency ? ` · ${r.currency}` : ""}</div>
                    </td>
                    {shown("identifier") && <td style={col2Td}><IdentifierCell value={r.identifier} asin={r.asin} canEdit={canEdit && !r.unmapped && !!r.asin} onSave={onSaveIdentifier} /></td>}
                    {shown("sku") && <td className="mono" style={shown("identifier") ? col3Td : col2Td} title={r.hasSellerSku ? `${r.sku}${r.skuCount > 1 ? ` (+${r.skuCount - 1} more SKU${r.skuCount - 1 === 1 ? "" : "s"})` : ""}` : "No seller SKU (all Amazon return SKUs)"}>{r.hasSellerSku ? <>{r.sku}{r.skuCount > 1 ? <span style={{ color: "var(--text-secondary)", fontSize: 10 }}> +{r.skuCount - 1}</span> : null}</> : <span style={{ color: "var(--text-secondary)" }}>—</span>}</td>}
                    {shown("brand") && <td style={{ fontSize: 12 }}>{r.brand || "—"}</td>}
                    {shown("months") && (r.months || []).map((m, i) => <td key={i} className="mono">{m.units == null ? "—" : nInt(m.units)}</td>)}
                    {shown("mtd") && <td className="mono pt-strong sku-mv-mtd">{nInt(num(r.mtdUnits))}</td>}
                    {shown("daily") && recentCols.map((d) => { const v = dailyUnitAt(r, d); return <td key={d} className="mono">{v == null ? "—" : nInt(v)}</td>; })}
                    <td className="mono pt-strong sku-mv-last5">{nInt(num(r.recentTotal))}</td>
                    {shown("prev") && <td className="mono">{nInt(num(r.prevTotal))}</td>}
                    {shown("move") && <td className="mono"><MoveBadge value={r.movementPercent} /></td>}
                    {shown("avg") && <td className="mono">{r.avgMonthlyUnits == null ? "—" : r.avgMonthlyUnits}</td>}
                    {shown("runRate") && <td className="mono">{r.mtdRunRate == null ? "—" : r.mtdRunRate}</td>}
                    {shown("projected") && <td className="mono">{r.projectedUnits == null ? "—" : nInt(r.projectedUnits)}</td>}
                    {shown("status") && <td><StatusBadge status={r.status} /></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!sorted.length && <div className="empty-note" style={{ padding: "14px 16px" }}>{rawRows.length ? "No ASINs match this search or movement filter." : "No ASINs found for this scope."}</div>}
          {pageCount > 1 && <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border-default)" }}><Pagination page={page} pageCount={pageCount} onChange={setPage} /></div>}
        </div>

        <div className="footer-note">
          One row per account + marketplace + currency + ASIN; every legitimate SKU mapped to an ASIN is combined once (the representative SKU excludes Amazon <code>amzn…</code> return SKUs). Units come from the durable enriched Order Line Items history — priced + explicit-zero + SKU-identifiable pending units count; cancelled units never count; unresolved pending units without a usable ASIN stay honestly Unmapped. The three completed months, the {mtdLabel} window, and the Last {N} / Previous {N} windows are all computed from this account's latest proven order date ({fmtDateHuman(data.effectiveAsOf)}), never your browser's clock. A month or date before this account's coverage shows an em dash (unavailable); a covered date with no units is an honest 0. Changing the window (N) recomputes Last {N} / Previous {N} locally from the saved daily history — no export. Identifiers are your own per-ASIN labels; the column chooser, the window and identifiers all save automatically. No action here ever creates a DataDoe export.
        </div>
      </>}

      {bulkOpen && <BulkIdentifierModal rows={sorted} accountName={accountName} onClose={() => setBulkOpen(false)} onApply={onBulkIdentifiers} />}
    </div>
  );
}
