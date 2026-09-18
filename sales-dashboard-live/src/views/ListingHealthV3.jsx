// Listing Health v3 -- READ-ONLY preview (Phase 3, default-OFF LISTING_HEALTH_V3 flag). Additive; the v1 page is the
// production default and is untouched. Sales/Units come only from durable enriched OLI (server), change with the
// selected inclusive window, and NEVER call DataDoe. Status/issues/inventory always use the latest saved snapshot.
// All React hooks are unconditional and above every early return (hook-order stable); no full-page/blank transition --
// the report surface renders its own loading/empty/partial/unavailable states while data refreshes.

import React, { useMemo, useState } from "react";
import { ShieldAlert } from "lucide-react";

import {
  buildV3Rows, buildV3PriorityActions, v3ExportRows, v3WindowStatusLabel,
  fmtOnHand, fmtBool, fmtIssue, GATE_RANK, V3_GATES,
} from "../lib/listing-health-v3-view.js";
import { reportFilename } from "../lib/csv.js";
import { fmtMoney, nInt } from "../lib/format.js";
import {
  ExportButton, FreshnessBar, IdentityCell, Notice, Pagination, ReportHeader,
  SearchField, SelectField, SnapshotState, SortTh, StaleScopeNotice, sortRows, useSortState,
} from "./shared.jsx";

const PAGE_SIZE = 50;
const ACCESSORS = {
  productName: (r) => String(r.productName || r.sku || "").toLowerCase(),
  gate: (r) => GATE_RANK[r.gate],
  status: (r) => String(r.listingStatus || "").toLowerCase(),
  channel: (r) => String(r.channel || "").toLowerCase(),
  price: (r) => (r.price === null || r.price === undefined ? -1 : Number(r.price)),
  onHandFba: (r) => (r.onHandFba === null || r.onHandFba === undefined ? -1 : Number(r.onHandFba)),
  onHandFbm: (r) => (r.onHandFbm === null || r.onHandFbm === undefined ? -1 : Number(r.onHandFbm)),
  sales: (r) => Number(r.sales) || 0,
  units: (r) => Number(r.units) || 0,
  salesAtRisk: (r) => Number(r.salesAtRisk) || 0,
};

const CONFIDENCE_LABEL = { confirmed: "Confirmed", possible: "Possible", unavailable: "Unavailable" };

const WINDOW_PRESETS = [
  { value: "7D", label: "Last 7 days" },
  { value: "14D", label: "Last 14 days" },
  { value: "30D", label: "Last 30 days" },
  { value: "MONTH", label: "Calendar month" },
  { value: "CUSTOM", label: "Custom range" },
];

export default function ListingHealthV3({ data, loading, error, accountName, selectedBrand, currency, window: win, onWindowChange }) {
  // --- hooks: ALL unconditional, above every early return ---
  const [search, setSearch] = useState("");
  const [gateFilter, setGateFilter] = useState("FLAGGED");
  const [channelFilter, setChannelFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [priorityOpen, setPriorityOpen] = useState(false); // Priority Actions collapsed by default
  const [monthInput, setMonthInput] = useState((win && win.month) || "");
  const [customFrom, setCustomFrom] = useState((win && win.from) || "");
  const [customTo, setCustomTo] = useState((win && win.to) || "");
  const [sort, onSort] = useSortState("salesAtRisk", ["productName", "status", "channel", "gate"]);

  const preset = (win && win.preset) || "30D";
  const rows = useMemo(() => buildV3Rows(data, selectedBrand), [data, selectedBrand]);
  const priority = useMemo(() => buildV3PriorityActions(rows), [rows]);
  const windowStatus = useMemo(() => v3WindowStatusLabel(data), [data]);
  const counts = useMemo(() => {
    const c = {};
    for (const r of rows) c[r.gate] = (c[r.gate] || 0) + 1;
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (gateFilter === "FLAGGED" && !r.flagged) return false;
      if (gateFilter !== "FLAGGED" && gateFilter !== "ALL" && r.gate !== gateFilter) return false;
      if (channelFilter !== "ALL" && (r.channel || "unknown") !== channelFilter) return false;
      if (!q) return true;
      return `${r.sku || ""} ${r.asin || ""} ${r.productName || ""} ${r.brand || ""} ${fmtIssue(r.issues)} ${r.whyFlagged || ""}`.toLowerCase().includes(q);
    });
  }, [rows, search, gateFilter, channelFilter]);

  const sorted = useMemo(() => sortRows(filtered, ACCESSORS, sort, "salesAtRisk"), [filtered, sort]);
  React.useEffect(() => { setPage(1); }, [search, gateFilter, channelFilter, preset, data]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageRows = useMemo(() => sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [sorted, page]);

  const asOf = data && data.asOf;
  const cur = (data && data.currencies && data.currencies[0]) || currency || "USD";
  const money = (v) => fmtMoney(Number(v) || 0, cur);

  const applyPreset = (value) => {
    if (value === "MONTH") { onWindowChange({ preset: "MONTH", month: monthInput || (asOf ? asOf.slice(0, 7) : "") }); return; }
    if (value === "CUSTOM") { if (customFrom && customTo) onWindowChange({ preset: "CUSTOM", from: customFrom, to: customTo }); else onWindowChange({ preset: "CUSTOM", from: customFrom, to: customTo }); return; }
    onWindowChange({ preset: value });
  };

  const exportTable = async () => {
    const exportRows = v3ExportRows(sorted); // EXACTLY the authorized, filtered + sorted rows shown
    if (!exportRows.length) return;
    const cols = Object.keys(exportRows[0]);
    const matrix = [cols, ...exportRows.map((r) => cols.map((c) => r[c]))];
    const { buildXlsx } = await import("../lib/xlsx.js");
    const bytes = buildXlsx([{ name: "Listing Health v3", rows: matrix, freezeHeaderRows: 1 }]);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const link = document.createElement("a");
    link.href = url; link.download = `${reportFilename("listing-health-v3", accountName, asOf)}.xlsx`;
    document.body.appendChild(link); link.click(); document.body.removeChild(link); URL.revokeObjectURL(url);
  };

  const gateOptions = [
    { value: "FLAGGED", label: `Flagged (${rows.filter((r) => r.flagged).length})` },
    { value: "ALL", label: `All listings (${rows.length})` },
    ...Object.keys(V3_GATES).filter((g) => g !== "ok" && counts[g]).map((g) => ({ value: g, label: `${V3_GATES[g].label} (${counts[g]})` })),
  ];
  const channelOptions = [
    { value: "ALL", label: "All fulfilment" },
    { value: "FBA", label: "FBA" },
    { value: "FBM", label: "FBM" },
  ];

  const state = <SnapshotState data={data} loading={loading} error={error} label="Listing Health — v3 preview (read-only)" icon={<ShieldAlert size={22} />} />;

  return (
    <div className="container skupl-page">
      <ReportHeader
        title="Listing Health — v3 preview (read-only)"
        subtitle="OLI-based sales/units over a selected window · latest snapshot for status, issues & inventory · creates no exports"
      />
      <StaleScopeNotice data={data} />

      {/* Date-window controls: change ONLY sales/units (durable OLI re-aggregation; zero exports). */}
      <div className="skupl-toolbar" style={{ marginBottom: 8 }}>
        <SelectField label="Sales window" value={preset} onChange={applyPreset} options={WINDOW_PRESETS} />
        {preset === "MONTH" && (
          <label className="auth-field" style={{ minWidth: 150 }}><span>Month</span>
            <input type="month" value={monthInput} onChange={(e) => { setMonthInput(e.target.value); if (e.target.value) onWindowChange({ preset: "MONTH", month: e.target.value }); }} aria-label="Calendar month" />
          </label>
        )}
        {preset === "CUSTOM" && (
          <>
            <label className="auth-field" style={{ minWidth: 140 }}><span>From</span>
              <input type="date" value={customFrom} max={asOf || undefined} onChange={(e) => { setCustomFrom(e.target.value); if (e.target.value && customTo) onWindowChange({ preset: "CUSTOM", from: e.target.value, to: customTo }); }} aria-label="Custom from date" />
            </label>
            <label className="auth-field" style={{ minWidth: 140 }}><span>To</span>
              <input type="date" value={customTo} max={asOf || undefined} onChange={(e) => { setCustomTo(e.target.value); if (customFrom && e.target.value) onWindowChange({ preset: "CUSTOM", from: customFrom, to: e.target.value }); }} aria-label="Custom to date" />
            </label>
          </>
        )}
        <div className="skupl-toolbar-spacer" />
        <span className={`pt-badge sku-badge-${windowStatus.tone}`} title={windowStatus.note}>{windowStatus.label}</span>
      </div>

      {state}

      {data && !data.snapshotMissing && (
        <>
          <FreshnessBar items={[
            data.window ? `Window ${data.window.from} → ${data.window.to} (${data.window.days}d)` : null,
            data.inventory ? `Inventory snapshot ${data.inventory.snapshotDate || "unavailable"}` : null,
            data.completeness && data.completeness.provisional ? "Provisional (some days still finalising)" : null,
            "Read-only preview · zero DataDoe exports",
          ]} />

          {windowStatus.label !== "Covered" && <Notice tone="warn">{windowStatus.note}</Notice>}
          {data.evidence && data.evidence.listingsEvidenceAvailable === false && (
            <Notice tone="warn">{data.evidence.listingsUnavailableReason || "Listings snapshot not yet available in this preview."}</Notice>
          )}
          {data.issuesAvailable === false && (
            <Notice>{data.issuesUnavailableReason || "Amazon issue/Buyable/Discoverable signals are unavailable until Listings (Raw JSON) evidence is saved."}</Notice>
          )}

          {/* Priority Actions -- COLLAPSED by default; expand for ranked evidence, reason, confidence, action. */}
          <div className="panel" style={{ marginTop: 10 }}>
            <button type="button" className="auth-link" aria-expanded={priorityOpen} onClick={() => setPriorityOpen((v) => !v)} style={{ fontWeight: 600 }}>
              {priorityOpen ? "▾" : "▸"} Priority Actions ({priority.length}) {priority.length ? "" : "— none"}
            </button>
            {priorityOpen && (
              <div className="insight-list" style={{ marginTop: 8 }}>
                {priority.length === 0 && <div className="empty-note">No action needed from this preview right now.</div>}
                {priority.slice(0, 50).map((p) => (
                  <div className={`insight-row insight-${p.severity}`} key={p.id}>
                    <div className="insight-head"><span className={`pt-badge sku-badge-${V3_GATES[p.gate] ? V3_GATES[p.gate].tone : "warn"}`}>{p.gateLabel}</span> <span className="insight-title">{p.productName || p.sku}</span> <span className="insight-money mono">{money(p.salesAtRisk)}</span></div>
                    <div className="insight-why">{p.why}</div>
                    <div className="insight-evidence">{p.evidence.map((e, i) => <span className="insight-chip" key={i}><em>{e.label}</em> <b className="mono">{e.value}</b></span>)}</div>
                    <div className="insight-action"><strong>Do this:</strong> {p.action}</div>
                    <div className="insight-foot">confidence {p.confidence} · exposure {money(p.salesAtRisk)} (selected-period sales for a listing flagged now — not proven lost revenue)</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel" style={{ marginTop: 10 }}>
            <div className="skupl-toolbar">
              <SearchField value={search} onChange={setSearch} placeholder="Search SKU, ASIN, product, issue…" />
              <SelectField label="Health gate" value={gateFilter} onChange={setGateFilter} options={gateOptions} />
              <SelectField label="Fulfilment" value={channelFilter} onChange={setChannelFilter} options={channelOptions} />
              <div className="skupl-toolbar-spacer" />
              <ExportButton onClick={exportTable} disabled={sorted.length === 0} label="Download Excel" />
            </div>

            <div style={{ overflowX: "auto" }}>
              <table className="plan-table listing-health-table">
                <thead>
                  <tr>
                    <SortTh className="pt-id" label="Product / SKU" col="productName" sort={sort} onSort={onSort} align="left" />
                    <SortTh label="Amazon Listing Status" col="status" sort={sort} onSort={onSort} align="left" hint="Amazon's own source listing status — never a derived value" />
                    <SortTh label="Health Finding" col="gate" sort={sort} onSort={onSort} align="left" hint="A derived health condition from explicit evidence — not the Amazon status" />
                    <th className="pt-left">Confidence</th>
                    <SortTh label="Fulfilment" col="channel" sort={sort} onSort={onSort} align="left" />
                    <SortTh label="Price" col="price" sort={sort} onSort={onSort} />
                    <SortTh label="On Hand FBA" col="onHandFba" sort={sort} onSort={onSort} />
                    <SortTh label="On Hand FBM" col="onHandFbm" sort={sort} onSort={onSort} />
                    <SortTh label="Sales" col="sales" sort={sort} onSort={onSort} hint="Selected window (durable OLI)" />
                    <SortTh label="Units" col="units" sort={sort} onSort={onSort} hint="Selected window (durable OLI)" />
                    <SortTh label="Sales at Risk" col="salesAtRisk" sort={sort} onSort={onSort} hint="Selected-period exposure for a listing flagged now — not proven lost revenue" />
                    <th className="pt-left">Buyable</th>
                    <th className="pt-left">Discoverable</th>
                    <th className="pt-left">Live Offer</th>
                    <th className="pt-left">Amazon Issue</th>
                    <th className="pt-left">Evidence source</th>
                    <th className="pt-left">As of</th>
                    <th className="pt-left">Why Flagged</th>
                    <th className="pt-left">Recommended Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r) => (
                    <tr key={(r.sku || "") + "|" + (r.asin || "")} className={r.gateMeta && r.gateMeta.tone === "bad" ? "skupl-row-loss" : (r.flagged ? "plan-restock" : "")}>
                      <IdentityCell name={r.productName} primary={r.sku || "—"} secondary={r.asin} brand={r.brand} />
                      <td className="pt-left">{r.listingStatus || "Unavailable"}</td>
                      <td className="pt-left"><span className={`pt-badge sku-badge-${r.gateMeta ? r.gateMeta.tone : "ok"}`}>{r.gateMeta ? r.gateMeta.label : r.gate}</span></td>
                      <td className="pt-left">{CONFIDENCE_LABEL[r.confidence] || "Unavailable"}</td>
                      <td className="pt-left">{r.channel || "Unavailable"}</td>
                      <td className="mono">{r.price === null || r.price === undefined ? "Unavailable" : money(r.price)}</td>
                      <td className="mono">{fmtOnHand(r.onHandFba, r.onHandFbaApplicable)}</td>
                      <td className="mono">{fmtOnHand(r.onHandFbm, r.onHandFbmApplicable)}</td>
                      <td className="mono">{money(r.sales)}</td>
                      <td className="mono">{nInt(r.units)}</td>
                      <td className={`mono${Number(r.salesAtRisk) > 0 ? " sku-neg" : ""}`}>{money(r.salesAtRisk)}</td>
                      <td className="pt-left">{fmtBool(r.buyable)}</td>
                      <td className="pt-left">{fmtBool(r.discoverable)}</td>
                      <td className="pt-left">{fmtBool(r.liveOffer)}</td>
                      <td className="pt-left">{fmtIssue(r.issues) || "—"}</td>
                      <td className="pt-left">{r.evidenceSource || "Unavailable"}</td>
                      <td className="pt-left">{r.evidenceAsOf ? (r.evidenceStale ? `${r.evidenceAsOf} · stale` : r.evidenceAsOf) : "Unavailable"}</td>
                      <td className="pt-left">{r.whyFlagged || "—"}</td>
                      <td className="pt-left">{r.recommendedAction || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {sorted.length === 0 && <div className="empty-note">No listings match the current filters, or no saved listings evidence for this account yet.</div>}
            <Pagination page={page} pageCount={pageCount} onChange={setPage} />
          </div>

          <div className="footer-note">
            Read-only preview. Sales &amp; Units come only from durable Order Line Items for the selected window; status, issues and inventory use the latest saved snapshot. Selecting a date creates no DataDoe export.
          </div>
        </>
      )}
    </div>
  );
}
