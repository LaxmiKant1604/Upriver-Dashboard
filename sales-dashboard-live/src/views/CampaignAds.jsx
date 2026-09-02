// Ad Performance by Campaign -- premium operational tab (DORMANT behind CAMPAIGN_ADS_TAB; ASIN Ads stays live).
// Reads /api/campaign-brand-mapping?action=view (VIEWING = account+brand authz). Editing (inline + bulk mapping)
// additionally requires the can_manage_campaign_brand_mapping capability (same endpoint). Campaign ID is identity;
// names/status may change without losing a mapping. New campaigns appear as Unmapped; Unmapped spend/sales is shown,
// never silently assigned or dropped. Currencies are never combined. Self-contained; App.jsx only routes to it.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Search, Download, Upload, Megaphone } from "lucide-react";
import { fmtMoney, fmtRate, compactNumber } from "../lib/format.js";
import { downloadCsv } from "../lib/csv.js";
import { DataQualityAlert, EmptyState, SegmentedControl, SkeletonMetricGrid } from "../components/ui.jsx";

const S = (v) => (v == null ? "" : String(v));
const nInt = (v) => (Number(v) || 0).toLocaleString("en-US");
const pctOf = (v) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const ratio = (v, digits = 2) => (v == null ? "—" : Number(v).toFixed(digits));

function authFetch(path, token, options = {}) {
  return fetch(path, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) } });
}

const BULK_COLUMNS = ["account", "marketplace", "ads_profile_id", "campaign_id", "campaign_name", "campaign_type", "campaign_status", "current_brand", "new_brand", "action", "note", "last_synced_at"];

export default function CampaignAds({ accountId, accountName, selectedBrand = "ALL", accessToken, isAdmin = false }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [canEdit, setCanEdit] = useState(false);
  const [brands, setBrands] = useState([]); // trusted brands for mapping
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL"); // ALL | MAPPED | UNMAPPED
  const [currency, setCurrency] = useState("");
  const [notice, setNotice] = useState(null);
  const reqRef = useRef(0);
  const fileRef = useRef(null);

  const brandParam = selectedBrand && selectedBrand !== "ALL" ? selectedBrand : "";

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
      const curs = Object.keys(body.summary?.byCurrency || {});
      setCurrency((c) => (c && curs.includes(c) ? c : curs[0] || ""));
    } catch (e) { if (my === reqRef.current) { setError(e.message || "Failed to load Campaign Ads."); } }
    finally { if (my === reqRef.current) setLoading(false); }
  }, [accountId, accessToken, brandParam]);

  // Editing capability + trusted brands: the mapping API's brands endpoint is capability-gated, so a 200 proves the
  // user may edit; a 403 leaves the tab read-only (viewing still works).
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

  const currencies = useMemo(() => Object.keys(data?.summary?.byCurrency || {}), [data]);
  const kpi = data?.summary?.byCurrency?.[currency]?.account || null;

  const campaigns = useMemo(() => {
    const list = (data?.campaigns || []).filter((c) => (currency ? c.currency === currency : true));
    const q = search.trim().toLowerCase();
    return list.filter((c) => {
      if (statusFilter === "MAPPED" && !c.mapped) return false;
      if (statusFilter === "UNMAPPED" && c.mapped) return false;
      if (q && !(`${c.campaignName} ${c.campaignId} ${c.brandDisplay}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [data, currency, search, statusFilter]);

  const brandByKey = useMemo(() => new Map(brands.map((b) => [b.key, b.display || b.key])), [brands]);

  const mapOne = useCallback(async (c, brandValue) => {
    if (!canEdit) return;
    const body = brandValue
      ? { kind: "assign", accountId, campaignId: c.campaignId, marketplace: c.marketplace, adsProfileId: c.adsProfileId, brand: brandValue }
      : { kind: "clear", accountId, campaignId: c.campaignId, marketplace: c.marketplace, adsProfileId: c.adsProfileId };
    setNotice(null);
    const r = await authFetch("/api/campaign-brand-mapping", accessToken, { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) { const b = await r.json().catch(() => ({})); setNotice({ tone: "error", msg: b.error || "Mapping failed." }); return; }
    await load();
  }, [canEdit, accountId, accessToken, load]);

  const downloadTemplate = useCallback(() => {
    const rows = [BULK_COLUMNS];
    for (const c of data?.campaigns || []) {
      rows.push([accountId, c.marketplace, c.adsProfileId, c.campaignId, c.campaignName, c.campaignType, c.campaignStatus, c.brandDisplay || "", "", "", "", c.lastObservedDate || ""]);
    }
    downloadCsv(rows, `campaign-brand-mapping-${S(accountName || accountId).replace(/[^a-z0-9]+/gi, "-")}.csv`);
  }, [data, accountId, accountName]);

  const onImportFile = useCallback(async (file) => {
    if (!file || !canEdit) return;
    setNotice(null);
    try {
      let matrix;
      if (/\.xlsx$/i.test(file.name)) { const { readXlsxFirstSheet } = await import("../lib/xlsx-read.js"); matrix = await readXlsxFirstSheet(await file.arrayBuffer()); }
      else { matrix = (await file.text()).split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(",").map((x) => x.replace(/^"|"$/g, "").trim())); }
      if (!matrix || matrix.length < 2) { setNotice({ tone: "warning", msg: "The file has no data rows." }); return; }
      const head = matrix[0].map((h) => S(h).trim().toLowerCase());
      const idx = (name) => head.indexOf(name);
      const iCamp = idx("campaign_id"), iMkt = idx("marketplace"), iProf = idx("ads_profile_id"), iNew = idx("new_brand"), iNote = idx("note"), iAction = idx("action");
      if (iCamp < 0 || iMkt < 0) { setNotice({ tone: "error", msg: "The file must include at least campaign_id and marketplace columns." }); return; }
      const rows = [];
      for (const r of matrix.slice(1)) {
        const action = (iAction >= 0 ? S(r[iAction]) : "").trim().toUpperCase();
        const newBrand = iNew >= 0 ? S(r[iNew]).trim() : "";
        // Only rows with an explicit new_brand or a CLEAR action are applied; blank/no-action rows are ignored.
        if (!newBrand && action !== "CLEAR") continue;
        rows.push({ campaignId: S(r[iCamp]).trim(), marketplace: S(r[iMkt]).trim(), adsProfileId: iProf >= 0 ? S(r[iProf]).trim() : "", brand: action === "CLEAR" ? "" : newBrand, note: iNote >= 0 ? S(r[iNote]).trim() : "" });
      }
      if (!rows.length) { setNotice({ tone: "warning", msg: "No rows to apply (fill new_brand or set action=CLEAR)." }); return; }
      const resp = await authFetch("/api/campaign-brand-mapping", accessToken, { method: "POST", body: JSON.stringify({ kind: "bulk", accountId, rows }) });
      const b = await resp.json().catch(() => ({}));
      if (!resp.ok) { setNotice({ tone: "error", msg: b.error || "Bulk mapping failed; nothing was written." }); return; }
      setNotice({ tone: "success", msg: `Applied ${b.applied || rows.length} mapping(s).` });
      await load();
    } catch (e) { setNotice({ tone: "error", msg: e.message || "Could not read the file." }); }
    finally { if (fileRef.current) fileRef.current.value = ""; }
  }, [canEdit, accountId, accessToken, load]);

  const money = (v) => (v == null ? "—" : fmtMoney(v, currency || "USD"));
  const KPIS = kpi ? [
    { label: "Ad Spend", value: money(kpi.spend) },
    { label: "Ad Sales", value: money(kpi.sales) },
    { label: "Orders", value: nInt(kpi.orders) },
    { label: "Units", value: nInt(kpi.units) },
    { label: "Impressions", value: nInt(kpi.impressions) },
    { label: "Clicks", value: nInt(kpi.clicks) },
    { label: "CTR", value: pctOf(kpi.ctr) },
    { label: "CPC", value: kpi.cpc == null ? "—" : fmtMoney(kpi.cpc, currency || "USD", 2) },
    { label: "CVR", value: pctOf(kpi.cvr) },
    { label: "ROAS", value: ratio(kpi.roas) },
    { label: "ACoS", value: pctOf(kpi.acos) },
  ] : [];

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

      <div className="controls-bar dashboard-controls">
        <div className="chip-row" style={{ gap: 8 }}>
          <span className="ca-search"><Search size={14} aria-hidden="true" /><input type="text" aria-label="Search campaigns" placeholder="Search campaign, ID or brand" value={search} onChange={(e) => setSearch(e.target.value)} /></span>
          <SegmentedControl ariaLabel="Mapping status" size="sm" value={statusFilter} onChange={setStatusFilter} options={[{ value: "ALL", label: "All" }, { value: "MAPPED", label: "Mapped" }, { value: "UNMAPPED", label: "Unmapped" }]} />
          {currencies.length > 1 && <SegmentedControl ariaLabel="Currency" size="sm" value={currency} onChange={setCurrency} options={currencies.map((c) => ({ value: c, label: c }))} />}
        </div>
        <span className="chip-row" style={{ gap: 8 }}>
          <button type="button" className="plan-tool-btn" onClick={load} disabled={loading} title="Reload saved data (no export)"><RefreshCw size={14} className={loading ? "spin" : ""} aria-hidden="true" /> Reload</button>
          <button type="button" className="plan-tool-btn" onClick={downloadTemplate} disabled={!data?.campaigns?.length}><Download size={15} aria-hidden="true" /> Download mapping</button>
          {canEdit && <>
            <button type="button" className="plan-tool-btn" onClick={() => fileRef.current && fileRef.current.click()}><Upload size={15} aria-hidden="true" /> Bulk map</button>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.xlsx,text/csv" style={{ display: "none" }} onChange={(e) => onImportFile(e.target.files && e.target.files[0])} />
          </>}
        </span>
      </div>

      {loading && !data ? (
        <><SkeletonMetricGrid count={6} /><div className="panel panel-flush" style={{ marginTop: 12, height: 220 }} /></>
      ) : !accountId ? (
        <div className="panel"><EmptyState icon={<Megaphone size={19} aria-hidden="true" />} title="No account selected">Choose an account in the command bar to view its campaign advertising.</EmptyState></div>
      ) : !data || !data.hasData ? (
        <div className="panel"><EmptyState icon={<Megaphone size={19} aria-hidden="true" />} title="No campaign data yet">Campaign advertising will appear here after the scheduled Campaign Ads sync runs. Nothing is fabricated.</EmptyState></div>
      ) : (
        <>
          <div className="metric-grid ca-kpis">
            {KPIS.map((k) => (
              <div className="metric-card" key={k.label}>
                <div className="metric-top"><div className="metric-label">{k.label}</div></div>
                <div className="metric-value">{k.value}</div>
              </div>
            ))}
          </div>

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
                  {campaigns.map((c) => (
                    <tr key={`${c.campaignId}|${c.marketplace}|${c.adsProfileId}`}>
                      <td className="pt-id">
                        <div className="pt-name">{c.campaignName || c.campaignId}</div>
                        <div className="pt-meta">{c.campaignId} · {c.marketplace}{c.adsProfileId ? ` · profile ${c.adsProfileId}` : ""}</div>
                      </td>
                      <td>{c.campaignType || "—"}<div className="pt-meta">{c.campaignStatus || ""}</div></td>
                      <td>
                        {canEdit ? (
                          <select className="ca-map-select" aria-label={`Brand for ${c.campaignName || c.campaignId}`} value={c.mapped ? c.brandKey : ""} onChange={(e) => mapOne(c, e.target.value)}>
                            <option value="">Unmapped</option>
                            {brands.map((b) => <option value={b.key} key={b.key}>{b.display || b.key}</option>)}
                          </select>
                        ) : (c.mapped ? <span className="pt-badge sku-badge-ok">{c.brandDisplay || brandByKey.get(c.brandKey) || c.brandKey}</span> : <span className="pt-badge sku-badge-neutral">Unmapped</span>)}
                      </td>
                      <td className="mono">{money(c.spend)}</td>
                      <td className="mono">{money(c.sales)}</td>
                      <td className="mono">{nInt(c.orders)}</td>
                      <td className="mono">{nInt(c.units)}</td>
                      <td className="mono">{nInt(c.impressions)}</td>
                      <td className="mono">{nInt(c.clicks)}</td>
                      <td className="mono">{pctOf(c.ctr)}</td>
                      <td className="mono">{c.cpc == null ? "—" : fmtMoney(c.cpc, currency || "USD", 2)}</td>
                      <td className="mono">{pctOf(c.cvr)}</td>
                      <td className="mono">{ratio(c.roas)}</td>
                      <td className="mono">{pctOf(c.acos)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="footer-note">
            Campaign metrics come from DataDoe Ad Performance by Campaign &amp; Date at daily campaign grain. Campaign ID is the identity; names and status can change without losing a mapping. Unmapped spend and sales are shown, never assigned to a brand or dropped, so account totals conserve exactly. Currencies are never combined. Opening or reloading this report reads saved data only and never calls DataDoe.
          </div>
        </>
      )}
    </div>
  );
}
