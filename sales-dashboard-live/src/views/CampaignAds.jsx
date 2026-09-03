// Ad Performance by Campaign -- ONE secure, responsive Campaign Ads workspace (behind CAMPAIGN_ADS_TAB) with three
// tabs: Performance / Wasted Spend / Brand Mapping. Powered ONLY by the durable DataDoe source "Ad Performance by
// Campaign & Date" (ads-campaign-date) via /api/campaign-brand-mapping?action=view (account + brand authz enforced
// SERVER-side; a brand-restricted viewer only ever receives permitted campaigns). The full per-campaign daily history
// is loaded ONCE per account/brand; changing the date window (7D default / 14D / 30D / Custom) or switching tabs
// re-windows + recomputes IN PLACE from that data -- ZERO refetch, ZERO DataDoe tokens, no remount, no flash. Windows
// are inclusive and anchored on the account's LATEST PROVEN date (never the browser clock). Campaign ID is identity;
// names/status may change without losing a mapping. Unmapped spend/sales is shown, never assigned or dropped.
// Currencies are never combined. INTENTIONALLY OMITTED: keyword / search-term / ASIN (targeting) analysis -- this
// source is campaign-day grain and carries no such dimension, so the retired PPC report's keyword/search-term views are
// not reproduced here (documented in the footer). Editing (inline + bulk mapping) additionally requires the
// can_manage_campaign_brand_mapping capability.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Search, Download, Upload, Megaphone, BarChart3, AlertTriangle, Tags } from "lucide-react";
import { fmtMoney } from "../lib/format.js";
import { downloadCsvMatrix } from "../lib/csv.js";
import { buildCampaignMappingMatrix, validateCampaignMappingRows, validateCampaignMappingText } from "../lib/campaign-mapping-import.js";
import { DataQualityAlert, EmptyState, SegmentedControl, SkeletonMetricGrid } from "../components/ui.jsx";
import { resolveWindow, windowCampaigns, summarizeWindow, classifyWaste, CAMPAIGN_DATE_PRESETS } from "../lib/campaign-ads-view.js";

const S = (v) => (v == null ? "" : String(v));
const nInt = (v) => (Number(v) || 0).toLocaleString("en-US");
const pctOf = (v) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const ratio = (v, digits = 2) => (v == null ? "—" : Number(v).toFixed(digits));

function authFetch(path, token, options = {}) {
  return fetch(path, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) } });
}

const TABS = [
  { key: "performance", label: "Performance", icon: BarChart3 },
  { key: "wasted", label: "Wasted Spend", icon: AlertTriangle },
  { key: "mapping", label: "Brand Mapping", icon: Tags },
];
const DATE_OPTIONS = [...CAMPAIGN_DATE_PRESETS.map((p) => ({ value: p.key, label: p.label })), { value: "CUSTOM", label: "Custom" }];

export default function CampaignAds({ accountId, accountName, selectedBrand = "ALL", accessToken, isAdmin = false }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [canEdit, setCanEdit] = useState(false);
  const [brands, setBrands] = useState([]); // trusted brands for mapping
  const [notice, setNotice] = useState(null);
  // Cross-tab-stable controls (preserved while switching tabs; only account/brand changes trigger a reload).
  const [tab, setTab] = useState("performance");
  const [preset, setPreset] = useState("7D"); // 7D default | 14D | 30D | CUSTOM
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL"); // ALL | MAPPED | UNMAPPED
  const [wasteFilter, setWasteFilter] = useState("ALL"); // ALL | WASTED | REVIEW
  const [currency, setCurrency] = useState("");
  const reqRef = useRef(0);
  const fileRef = useRef(null);

  const brandParam = selectedBrand && selectedBrand !== "ALL" ? selectedBrand : "";

  // Load the FULL per-campaign daily history ONCE per (account, brand). No date params: the server returns every
  // campaign's complete `daily` breakdown + proven coverage, and the browser windows it locally. This never calls DataDoe.
  const load = useCallback(async () => {
    if (!accountId || !accessToken) { setData(null); return; }
    const my = ++reqRef.current;
    setLoading(true); setError(null);
    try {
      const q = new URLSearchParams({ action: "view", accountId }); if (brandParam) q.set("brand", brandParam);
      const r = await authFetch(`/api/campaign-brand-mapping?${q}`, accessToken);
      if (my !== reqRef.current) return; // stale-response guard
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || `Request failed (${r.status})`); }
      const body = await r.json();
      if (my !== reqRef.current) return;
      setData(body);
      const curs = [...new Set((body.campaigns || []).map((c) => c.currency).filter(Boolean))];
      setCurrency((c) => (c && curs.includes(c) ? c : curs[0] || ""));
    } catch (e) { if (my === reqRef.current) { setError(e.message || "Failed to load Campaign Ads."); } }
    finally { if (my === reqRef.current) setLoading(false); }
  }, [accountId, accessToken, brandParam]);

  // Editing capability + trusted brands: the mapping API's brands endpoint is capability-gated, so a 200 proves the
  // user may edit; a 403 leaves the workspace read-only (viewing still works).
  const loadCapability = useCallback(async () => {
    if (!accountId || !accessToken) { setCanEdit(false); setBrands([]); return; }
    try {
      const r = await authFetch(`/api/campaign-brand-mapping?action=brands&accountId=${encodeURIComponent(accountId)}`, accessToken);
      if (r.ok) { const b = await r.json(); setCanEdit(true); setBrands(b.brands || []); }
      else { setCanEdit(false); setBrands([]); }
    } catch { setCanEdit(false); setBrands([]); }
  }, [accountId, accessToken]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadCapability(); }, [loadCapability]);

  const coverage = data?.coverage || null;
  const latestProvenDate = coverage?.latestProvenDate || null;
  const minDate = coverage?.minDate || null;
  const currencies = useMemo(() => [...new Set((data?.campaigns || []).map((c) => c.currency).filter(Boolean))], [data]);

  // Resolve the selected window (inclusive, anchored on the proven latest date, clamped to coverage). Recomputes on any
  // date change WITHOUT a network call.
  const win = useMemo(
    () => resolveWindow({ preset, customFrom, customTo, latestProvenDate, minDate }),
    [preset, customFrom, customTo, latestProvenDate, minDate]
  );

  // Re-window every campaign to [win.from, win.to] locally, then isolate the selected currency (currencies never mix).
  const windowedAll = useMemo(() => windowCampaigns(data?.campaigns || [], win.from, win.to), [data, win.from, win.to]);
  const windowedCur = useMemo(() => windowedAll.filter((c) => (currency ? c.currency === currency : true)), [windowedAll, currency]);
  const summary = useMemo(() => summarizeWindow(windowedAll), [windowedAll]);
  const kpi = summary.byCurrency?.[currency]?.account || null;
  const conservationOk = summary.byCurrency?.[currency]?.conservationOk !== false;

  const q = search.trim().toLowerCase();
  const matchesSearch = useCallback((c) => !q || `${c.campaignName} ${c.campaignId} ${c.brandDisplay}`.toLowerCase().includes(q), [q]);
  const matchesStatus = useCallback((c) => (statusFilter === "MAPPED" ? c.mapped : statusFilter === "UNMAPPED" ? !c.mapped : true), [statusFilter]);

  // Performance rows: the windowed campaigns for the selected currency, search + mapping-status filtered.
  const perfRows = useMemo(() => windowedCur.filter((c) => matchesStatus(c) && matchesSearch(c)), [windowedCur, matchesStatus, matchesSearch]);

  // Wasted Spend: deterministic classification over the SAME windowed rows (no new backend report), then filtered.
  const waste = useMemo(() => classifyWaste(windowedCur), [windowedCur]);
  const wasteRows = useMemo(
    () => waste.findings.filter((f) => (wasteFilter === "WASTED" ? f.severity === "wasted" : wasteFilter === "REVIEW" ? f.severity === "review" : true) && matchesStatus(f) && matchesSearch(f)),
    [waste, wasteFilter, matchesStatus, matchesSearch]
  );
  const wasteCur = waste.byCurrency?.[currency] || { wastedSpend: 0, reviewSpend: 0 };

  // Brand Mapping operates on the campaign IDENTITY, not a date slice: list every loaded campaign for the currency
  // (search + status filtered), independent of the selected window.
  const mappingRows = useMemo(() => (data?.campaigns || []).filter((c) => (currency ? c.currency === currency : true) && matchesStatus(c) && matchesSearch(c)), [data, currency, matchesStatus, matchesSearch]);

  const brandByKey = useMemo(() => new Map(brands.map((b) => [b.key, b.display || b.key])), [brands]);

  const onPreset = useCallback((next) => {
    // Entering Custom for the first time seeds the inputs with the current 30D window so they are never blank.
    if (next === "CUSTOM" && (!customFrom || !customTo)) {
      const w = resolveWindow({ preset: "30D", latestProvenDate, minDate });
      if (w.from && w.to) { setCustomFrom(w.from); setCustomTo(w.to); }
    }
    setPreset(next);
  }, [customFrom, customTo, latestProvenDate, minDate]);

  const mapOne = useCallback(async (c, brandValue) => {
    if (!canEdit) return;
    const body = brandValue
      ? { kind: "assign", accountId, campaignId: c.campaignId, marketplace: c.marketplace, adsProfileId: c.adsProfileId, brand: brandValue }
      : { kind: "clear", accountId, campaignId: c.campaignId, marketplace: c.marketplace, adsProfileId: c.adsProfileId };
    setNotice(null);
    const r = await authFetch("/api/campaign-brand-mapping", accessToken, { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) { const b = await r.json().catch(() => ({})); setNotice({ tone: "error", msg: b.error || "Mapping failed." }); return; }
    await load(); // mapping-revision zero-export refresh
  }, [canEdit, accountId, accessToken, load]);

  const baseName = useCallback(() => `campaign-brand-mapping-${S(accountName || accountId).replace(/[^a-z0-9]+/gi, "-")}`, [accountName, accountId]);

  // XLSX is the RECOMMENDED template: account/marketplace/ads_profile_id/campaign_id are written as inline (text) cells
  // so Excel keeps long identifiers byte-for-byte instead of converting them to scientific notation.
  const downloadTemplate = useCallback(async () => {
    const matrix = buildCampaignMappingMatrix({ accountId, campaigns: data?.campaigns || [] });
    const { buildXlsx } = await import("../lib/xlsx.js");
    const bytes = buildXlsx([{ name: "Campaign Mapping", rows: matrix, freezeHeaderRows: 1 }]);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const link = document.createElement("a");
    link.href = url; link.download = `${baseName()}.xlsx`; link.click();
    URL.revokeObjectURL(url);
  }, [data, accountId, baseName]);

  // CSV remains available (BOM + formula-injection protection, real header row exactly once), but is NOT recommended:
  // Excel can silently convert long IDs to scientific notation -- the importer rejects such files with a clear message.
  const downloadTemplateCsv = useCallback(() => {
    const matrix = buildCampaignMappingMatrix({ accountId, campaigns: data?.campaigns || [] });
    downloadCsvMatrix(matrix, `${baseName()}.csv`);
    setNotice({ tone: "warning", msg: "CSV downloaded. Excel can convert long campaign IDs to scientific notation and lose digits — the XLSX template is recommended and keeps IDs exact." });
  }, [data, accountId, baseName]);

  const onImportFile = useCallback(async (file) => {
    if (!file || !canEdit) return;
    setNotice(null);
    try {
      // Parse to string[][] then run the ONE shared validator (CSV, TSV and XLSX all feed it). The RFC4180 parser
      // handles the BOM, quoted commas, escaped quotes, CRLF/LF and blank trailing cells; the XLSX reader yields the
      // same shape. A legacy 0,1,2... index row above the real header is skipped by the validator's header detection.
      let result;
      if (/\.xlsx$/i.test(file.name)) {
        const { readXlsxFirstSheet } = await import("../lib/xlsx-read.js");
        result = validateCampaignMappingRows(await readXlsxFirstSheet(await file.arrayBuffer()));
      } else {
        result = validateCampaignMappingText(await file.text());
      }
      const p = result.preview || {};
      const previewLine = `Preview: ${p.total || 0} data row(s) — ${p.assign || 0} to assign, ${p.clear || 0} to clear, ${p.ignored || 0} unchanged, ${p.invalid || 0} invalid.`;
      // All-or-nothing at the client too: any invalid row (or a missing header, or Excel-damaged IDs) -> zero API
      // calls, zero writes, with the exact reason.
      if (!result.ok) {
        if (result.missingHeader) { setNotice({ tone: "error", msg: result.message }); return; }
        if (result.nothingToApply) { setNotice({ tone: "warning", msg: previewLine + " " + result.message }); return; }
        const reasons = (result.errors || []).slice(0, 5).map((e) => `line ${e.line}: ${e.reason}`).join("; ");
        setNotice({ tone: "error", msg: `${result.message} ${previewLine}${reasons ? " [" + reasons + "]" : ""}` });
        return;
      }
      const resp = await authFetch("/api/campaign-brand-mapping", accessToken, {
        method: "POST",
        body: JSON.stringify({ kind: "bulk", accountId, rows: result.applyRows.map((r) => ({ campaignId: r.campaignId, marketplace: r.marketplace, adsProfileId: r.adsProfileId, brand: r.brand, note: r.note })) }),
      });
      const b = await resp.json().catch(() => ({}));
      if (!resp.ok) { setNotice({ tone: "error", msg: b.error || "Bulk mapping failed; nothing was written." }); return; }
      setNotice({ tone: "success", msg: `Applied ${b.applied || result.applyRows.length} mapping(s). ${previewLine}` });
      await load();
    } catch (e) { setNotice({ tone: "error", msg: e.message || "Could not read the file." }); }
    finally { if (fileRef.current) fileRef.current.value = ""; } // reset so the same corrected file can be re-selected
  }, [canEdit, accountId, accessToken, load]);

  const money = (v) => (v == null ? "—" : fmtMoney(v, currency || "USD"));
  const money2 = (v) => (v == null ? "—" : fmtMoney(v, currency || "USD", 2));
  const KPIS = kpi ? [
    { label: "Ad Spend", value: money(kpi.spend) },
    { label: "Ad Sales", value: money(kpi.sales) },
    { label: "Orders", value: nInt(kpi.orders) },
    { label: "Units", value: nInt(kpi.units) },
    { label: "Impressions", value: nInt(kpi.impressions) },
    { label: "Clicks", value: nInt(kpi.clicks) },
    { label: "CTR", value: pctOf(kpi.ctr) },
    { label: "CPC", value: money2(kpi.cpc) },
    { label: "CVR", value: pctOf(kpi.cvr) },
    { label: "ROAS", value: ratio(kpi.roas) },
    { label: "ACoS", value: pctOf(kpi.acos) },
  ] : [];

  const rangeLabel = win.from && win.to ? (win.from === win.to ? win.from : `${win.from} → ${win.to}`) : "—";
  const hasWindowRows = windowedCur.length > 0;

  return (
    <div className="container campaign-ads-page op-report">
      <div className="page-head">
        <div>
          <div className="page-title">Ad Performance by Campaign</div>
          <div className="page-sub">
            {accountName || "No account selected"}{selectedBrand === "ALL" ? " · All brands" : ` · ${selectedBrand}`}
            {currency ? ` · ${currency}` : ""}{data?.restricted ? " · brand-scoped" : ""}
          </div>
        </div>
      </div>

      {error && <DataQualityAlert tone="error" title="Campaign Ads could not be loaded" detail={error} />}
      {notice && <DataQualityAlert tone={notice.tone} title={notice.msg} />}

      {/* Tab bar -- one workspace, three views. Switching tabs preserves the account/brand/date/search/filters. */}
      <div className="ca-tabs" role="tablist" aria-label="Campaign Ads views">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={"ca-tab" + (tab === t.key ? " active" : "")} onClick={() => setTab(t.key)}>
              <Icon size={15} aria-hidden="true" /> {t.label}
            </button>
          );
        })}
      </div>

      {/* Shared controls. The date window drives Performance + Wasted Spend; Brand Mapping is date-independent (it maps
          campaign identities), so the date control is hidden there. Currency + search persist across all tabs. */}
      <div className="controls-bar dashboard-controls ca-controls">
        <div className="chip-row" style={{ gap: 8 }}>
          {tab !== "mapping" && (
            <>
              <SegmentedControl ariaLabel="Date window" size="sm" value={preset} onChange={onPreset} options={DATE_OPTIONS} />
              {preset === "CUSTOM" && (
                <span className="ca-daterange">
                  <input type="date" aria-label="From date" value={customFrom} min={minDate || undefined} max={latestProvenDate || undefined} onChange={(e) => setCustomFrom(e.target.value)} />
                  <span className="ca-daterange-sep">→</span>
                  <input type="date" aria-label="To date" value={customTo} min={minDate || undefined} max={latestProvenDate || undefined} onChange={(e) => setCustomTo(e.target.value)} />
                </span>
              )}
            </>
          )}
          <span className="ca-search"><Search size={14} aria-hidden="true" /><input type="text" aria-label="Search campaigns" placeholder="Search campaign, ID or brand" value={search} onChange={(e) => setSearch(e.target.value)} /></span>
          <SegmentedControl ariaLabel="Mapping status" size="sm" value={statusFilter} onChange={setStatusFilter} options={[{ value: "ALL", label: "All" }, { value: "MAPPED", label: "Mapped" }, { value: "UNMAPPED", label: "Unmapped" }]} />
          {tab === "wasted" && <SegmentedControl ariaLabel="Finding type" size="sm" value={wasteFilter} onChange={setWasteFilter} options={[{ value: "ALL", label: "All findings" }, { value: "WASTED", label: "Wasted" }, { value: "REVIEW", label: "Needs review" }]} />}
          {currencies.length > 1 && <SegmentedControl ariaLabel="Currency" size="sm" value={currency} onChange={setCurrency} options={currencies.map((c) => ({ value: c, label: c }))} />}
        </div>
        <span className="chip-row" style={{ gap: 8 }}>
          <button type="button" className="plan-tool-btn" onClick={load} disabled={loading} title="Reload saved data (no export)"><RefreshCw size={14} className={loading ? "spin" : ""} aria-hidden="true" /> Reload</button>
          {tab === "mapping" && <>
            <button type="button" className="plan-tool-btn" onClick={downloadTemplate} disabled={!data?.campaigns?.length} title="Recommended: keeps long campaign IDs exact"><Download size={15} aria-hidden="true" /> Download (XLSX)</button>
            <button type="button" className="plan-tool-btn" onClick={downloadTemplateCsv} disabled={!data?.campaigns?.length} title="CSV — Excel can damage long IDs; use the XLSX template instead">CSV</button>
            {canEdit && <>
              <button type="button" className="plan-tool-btn" onClick={() => fileRef.current && fileRef.current.click()}><Upload size={15} aria-hidden="true" /> Bulk map</button>
              <input ref={fileRef} type="file" accept=".csv,.tsv,.xlsx,text/csv" style={{ display: "none" }} onChange={(e) => onImportFile(e.target.files && e.target.files[0])} />
            </>}
          </>}
        </span>
      </div>

      {/* Coverage line -- honest window + proven latest date, never the browser clock; clamp/gaps surfaced. */}
      {tab !== "mapping" && data?.hasData && latestProvenDate && (
        <div className="ca-coverage">
          <span>Showing <strong>{rangeLabel}</strong> · data proven through <strong>{latestProvenDate}</strong>{minDate ? ` (history from ${minDate})` : ""}</span>
          {preset === "CUSTOM" && win.clamped && <span className="ca-coverage-warn">Custom range adjusted to available history.</span>}
          {!conservationOk && <span className="ca-coverage-warn">Totals could not be reconciled for this currency; showing raw campaign sums.</span>}
        </div>
      )}

      {loading && !data ? (
        <><SkeletonMetricGrid count={6} /><div className="panel panel-flush" style={{ marginTop: 12, height: 220 }} /></>
      ) : !accountId ? (
        <div className="panel"><EmptyState icon={<Megaphone size={19} aria-hidden="true" />} title="No account selected">Choose an account in the command bar to view its campaign advertising.</EmptyState></div>
      ) : !data || !data.hasData ? (
        <div className="panel"><EmptyState icon={<Megaphone size={19} aria-hidden="true" />} title="No campaign data yet">Campaign advertising will appear here after the scheduled Campaign Ads sync runs. Nothing is fabricated.</EmptyState></div>
      ) : (
        <>
          {/* ---- PERFORMANCE TAB ---- */}
          {tab === "performance" && (
            <>
              <div className="metric-grid ca-kpis">
                {KPIS.map((k) => (
                  <div className="metric-card" key={k.label}>
                    <div className="metric-top"><div className="metric-label">{k.label}</div></div>
                    <div className="metric-value">{k.value}</div>
                  </div>
                ))}
              </div>
              {!hasWindowRows ? (
                <div className="panel" style={{ marginTop: 14 }}><EmptyState icon={<BarChart3 size={19} aria-hidden="true" />} title="No campaign activity in this window">No campaigns had activity in {rangeLabel}{currency ? ` (${currency})` : ""}. Nothing is fabricated — widen the date range.</EmptyState></div>
              ) : (
                <section className="panel" style={{ marginTop: 14, padding: 0, overflow: "hidden" }}>
                  <div className="plan-scroll">
                    <table className="plan-table campaign-ads-table" style={{ minWidth: 1180 }}>
                      <thead>
                        <tr>
                          <th className="pt-id" style={{ textAlign: "left" }}>Campaign</th>
                          <th style={{ textAlign: "left" }}>Type</th>
                          <th style={{ textAlign: "left" }}>Brand</th>
                          <th>Spend</th><th>Ad Sales</th><th>Orders</th><th>Units</th><th>Impr.</th><th>Clicks</th>
                          <th>CTR</th><th>CPC</th><th>CVR</th><th>ROAS</th><th>ACoS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {perfRows.map((c) => (
                          <tr key={`${c.campaignId}|${c.marketplace}|${c.adsProfileId}`}>
                            <td className="pt-id">
                              <div className="pt-name">{c.campaignName || c.campaignId}</div>
                              <div className="pt-meta">{c.campaignId} · {c.marketplace}{c.adsProfileId ? ` · profile ${c.adsProfileId}` : ""}</div>
                            </td>
                            <td>{c.campaignType || "—"}<div className="pt-meta">{c.campaignStatus || ""}</div></td>
                            <td>{c.mapped ? <span className="pt-badge sku-badge-ok">{c.brandDisplay || brandByKey.get(c.brandKey) || c.brandKey}</span> : <span className="pt-badge sku-badge-neutral">Unmapped</span>}</td>
                            <td className="mono">{money(c.spend)}</td>
                            <td className="mono">{money(c.sales)}</td>
                            <td className="mono">{nInt(c.orders)}</td>
                            <td className="mono">{nInt(c.units)}</td>
                            <td className="mono">{nInt(c.impressions)}</td>
                            <td className="mono">{nInt(c.clicks)}</td>
                            <td className="mono">{pctOf(c.ctr)}</td>
                            <td className="mono">{money2(c.cpc)}</td>
                            <td className="mono">{pctOf(c.cvr)}</td>
                            <td className="mono">{ratio(c.roas)}</td>
                            <td className="mono">{pctOf(c.acos)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </>
          )}

          {/* ---- WASTED SPEND TAB ---- (same windowed rows, deterministic classification; no new backend report) */}
          {tab === "wasted" && (
            <>
              <div className="metric-grid ca-kpis ca-waste-kpis">
                <div className="metric-card ca-waste-card"><div className="metric-top"><div className="metric-label">Definite wasted spend</div></div><div className="metric-value ca-neg">{money(wasteCur.wastedSpend)}</div><div className="pt-meta">Spend with 0 ad sales · {waste.counts.zeroSales} campaign(s)</div></div>
                <div className="metric-card ca-waste-card"><div className="metric-top"><div className="metric-label">Needs review</div></div><div className="metric-value ca-warn-ink">{money(wasteCur.reviewSpend)}</div><div className="pt-meta">{waste.counts.review} campaign(s) flagged</div></div>
                <div className="metric-card"><div className="metric-top"><div className="metric-label">Clicks, no orders</div></div><div className="metric-value">{nInt(waste.counts.clicksNoOrders)}</div><div className="pt-meta">≥ {waste.thresholds.minClicksForReview} clicks, 0 orders</div></div>
                <div className="metric-card"><div className="metric-top"><div className="metric-label">High ACoS / Low ROAS</div></div><div className="metric-value">{nInt(waste.counts.highAcos)} / {nInt(waste.counts.lowRoas)}</div><div className="pt-meta">ACoS &gt; 50% · ROAS &lt; 2.00</div></div>
              </div>
              {!hasWindowRows ? (
                <div className="panel" style={{ marginTop: 14 }}><EmptyState icon={<AlertTriangle size={19} aria-hidden="true" />} title="No campaign activity in this window">Nothing to evaluate for {rangeLabel}{currency ? ` (${currency})` : ""}.</EmptyState></div>
              ) : wasteRows.length === 0 ? (
                <div className="panel" style={{ marginTop: 14 }}><EmptyState icon={<AlertTriangle size={19} aria-hidden="true" />} title="No wasted or review-worthy spend">No campaign in {rangeLabel} tripped a waste or review threshold. Spend is converting.</EmptyState></div>
              ) : (
                <section className="panel" style={{ marginTop: 14, padding: 0, overflow: "hidden" }}>
                  <div className="plan-scroll">
                    <table className="plan-table campaign-ads-table" style={{ minWidth: 1080 }}>
                      <thead>
                        <tr>
                          <th className="pt-id" style={{ textAlign: "left" }}>Campaign</th>
                          <th style={{ textAlign: "left" }}>Finding</th>
                          <th style={{ textAlign: "left" }}>Brand</th>
                          <th>Spend</th><th>Ad Sales</th><th>Clicks</th><th>ACoS</th><th>ROAS</th>
                          <th style={{ textAlign: "left" }}>Why flagged</th>
                        </tr>
                      </thead>
                      <tbody>
                        {wasteRows.map((f) => (
                          <tr key={`${f.campaignId}|${f.marketplace}|${f.adsProfileId}`}>
                            <td className="pt-id">
                              <div className="pt-name">{f.campaignName || f.campaignId}</div>
                              <div className="pt-meta">{f.campaignId} · {f.marketplace}{f.campaignType ? ` · ${f.campaignType}` : ""}</div>
                            </td>
                            <td><span className={"pt-badge " + (f.severity === "wasted" ? "sku-badge-bad" : "sku-badge-warn")}>{f.severity === "wasted" ? "Wasted" : "Needs review"}</span></td>
                            <td>{f.mapped ? <span className="pt-badge sku-badge-ok">{f.brandDisplay || brandByKey.get(f.brandKey) || f.brandKey}</span> : <span className="pt-badge sku-badge-neutral">Unmapped</span>}</td>
                            <td className="mono">{money(f.spend)}</td>
                            <td className="mono">{money(f.sales)}</td>
                            <td className="mono">{nInt(f.clicks)}</td>
                            <td className="mono">{pctOf(f.acos)}</td>
                            <td className="mono">{ratio(f.roas)}</td>
                            <td>
                              <div className="ca-reasons">
                                {f.reasons.map((r) => <span key={r.type} className="ca-reason" title={r.detail}>{r.label}</span>)}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </>
          )}

          {/* ---- BRAND MAPPING TAB ---- (campaign identity -> brand; date-independent) */}
          {tab === "mapping" && (
            <section className="panel" style={{ marginTop: 14, padding: 0, overflow: "hidden" }}>
              <div className="plan-scroll">
                <table className="plan-table campaign-ads-table" style={{ minWidth: 760 }}>
                  <thead>
                    <tr>
                      <th className="pt-id" style={{ textAlign: "left" }}>Campaign</th>
                      <th style={{ textAlign: "left" }}>Type</th>
                      <th>Currency</th>
                      <th style={{ textAlign: "left" }}>Brand</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mappingRows.map((c) => (
                      <tr key={`${c.campaignId}|${c.marketplace}|${c.adsProfileId}`}>
                        <td className="pt-id">
                          <div className="pt-name">{c.campaignName || c.campaignId}</div>
                          <div className="pt-meta">{c.campaignId} · {c.marketplace}{c.adsProfileId ? ` · profile ${c.adsProfileId}` : ""}</div>
                        </td>
                        <td>{c.campaignType || "—"}<div className="pt-meta">{c.campaignStatus || ""}</div></td>
                        <td className="mono" style={{ textAlign: "center" }}>{c.currency || "—"}</td>
                        <td>
                          {canEdit ? (
                            <select className="ca-map-select" aria-label={`Brand for ${c.campaignName || c.campaignId}`} value={c.mapped ? c.brandKey : ""} onChange={(e) => mapOne(c, e.target.value)}>
                              <option value="">Unmapped</option>
                              {brands.map((b) => <option value={b.key} key={b.key}>{b.display || b.key}</option>)}
                            </select>
                          ) : (c.mapped ? <span className="pt-badge sku-badge-ok">{c.brandDisplay || brandByKey.get(c.brandKey) || c.brandKey}</span> : <span className="pt-badge sku-badge-neutral">Unmapped</span>)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <div className="footer-note">
            One workspace over the durable DataDoe <strong>Ad Performance by Campaign &amp; Date</strong> source at daily campaign grain. Date windows are inclusive, anchored on the latest proven Campaign date (never the browser clock), and change the view in place with no export or refetch. Campaign ID is the identity; names and status can change without losing a mapping. Unmapped spend and sales are shown, never assigned to a brand or dropped, so account totals conserve exactly. Currencies are never combined. <strong>Wasted Spend</strong> classifies these same campaign-day rows: spend with zero ad sales is definite waste; clicks-without-orders (≥ {waste.thresholds.minClicksForReview} clicks), high ACoS and low ROAS are flagged for review. Keyword, search-term and ASIN/targeting analysis is intentionally omitted — this source has no such grain.
          </div>
        </>
      )}
    </div>
  );
}
